import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import type { Engine } from './engine.ts';
import { interpolateParams } from './loader.ts';
import type { Step, Workflow } from './schema.ts';
import {
  computeWorkflowHash,
  deleteState,
  type RunState,
  writeState,
} from './state.ts';

const SIGNAL_FILE = '.baton-signal';

type StepOutcome = 'success' | 'failed' | 'aborted';
type PromptUserFn = (message: string) => Promise<string>;

export interface RunWorkflowOptions {
  from?: string;
  workflowFile?: string;
  stateDir?: string;
  engine?: Engine;
  sessionIds?: Record<string, string>;
  /** Injected for testing: prompts user and returns their choice */
  promptUser?: PromptUserFn;
}

function cleanSignalFile(): void {
  if (existsSync(SIGNAL_FILE)) {
    unlinkSync(SIGNAL_FILE);
  }
}

/**
 * Find the conversation ID for a claude session spawned from the given cwd.
 * Claude stores transcripts as JSONL files in ~/.claude/projects/<encoded-cwd>/.
 * The file modified most recently after `startTime` is the one from our subprocess.
 */
function findConversationId(cwd: string, startTime: number): string | undefined {
  const encodedCwd = resolve(cwd).replace(/[/.]/g, '-');
  const projectDir = join(homedir(), '.claude', 'projects', encodedCwd);

  if (!existsSync(projectDir)) return undefined;

  let bestFile: string | undefined;
  let bestMtime = 0;

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const fullPath = join(projectDir, entry.name);
    const stat = Bun.file(fullPath);
    const mtime = stat.lastModified;
    if (mtime >= startTime && mtime > bestMtime) {
      bestMtime = mtime;
      bestFile = entry.name;
    }
  }

  if (!bestFile) return undefined;
  return bestFile.replace('.jsonl', '');
}

async function runShellStep(
  step: Step,
  params: Record<string, string>,
): Promise<StepOutcome> {
  if (!step.command) return 'failed';
  const command = interpolateParams(step.command, params);
  console.log(`  command: ${command}`);

  const proc = Bun.spawn(['sh', '-c', command], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;
  return exitCode === 0 ? 'success' : 'failed';
}

async function runAgentStep(
  step: Step,
  params: Record<string, string>,
  sessionIds: Record<string, string>,
  engine?: Engine,
): Promise<StepOutcome> {
  if (!step.prompt) return 'failed';
  let prompt = interpolateParams(step.prompt, params);

  // Engine prompt enrichment (appended so slash commands stay at prompt start)
  if (engine?.enrichPrompt) {
    const enrichment = engine.enrichPrompt(step.id, params);
    if (enrichment) {
      prompt = `${prompt}\n\n${enrichment}`;
    }
  }

  const args: string[] = ['claude'];

  if (step.session === 'resume') {
    const previousSessionId = findPreviousSessionId(sessionIds);
    if (previousSessionId) {
      args.push('--resume', previousSessionId);
    }
  }

  if (step.mode === 'headless') {
    args.push('-p');
  }

  args.push(prompt);
  console.log(`  mode: ${step.mode}`);

  if (step.mode === 'interactive') {
    console.log('  (/continue to advance, exit to stop)\n');
  }

  cleanSignalFile();

  const spawnTime = Date.now();
  const proc = Bun.spawn(args, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  let outcome: StepOutcome;
  if (step.mode === 'interactive') {
    outcome = await waitForSignalOrExit(proc);
  } else {
    const exitCode = await proc.exited;
    outcome = exitCode === 0 ? 'success' : 'failed';
  }

  const conversationId = findConversationId(process.cwd(), spawnTime);
  if (conversationId) {
    sessionIds[step.id] = conversationId;
    console.log(`  session: ${conversationId}`);
  }

  return outcome;
}

async function waitForSignalOrExit(proc: Subprocess): Promise<StepOutcome> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (existsSync(SIGNAL_FILE)) {
        clearInterval(interval);
        let action = 'continue';
        try {
          const raw = readFileSync(SIGNAL_FILE, 'utf-8').trim();
          const signal = JSON.parse(raw);
          action = signal.action ?? 'continue';
        } catch {
          // Malformed signal -- treat as continue
        }
        cleanSignalFile();
        proc.kill('SIGTERM');
        resolve(action === 'continue' ? 'success' : 'aborted');
      }
    }, 500);

    proc.exited.then(() => {
      clearInterval(interval);
      cleanSignalFile();
      resolve('aborted');
    });
  });
}

function findPreviousSessionId(
  sessionIds: Record<string, string>,
): string | undefined {
  const stepIds = Object.keys(sessionIds);
  if (stepIds.length === 0) return undefined;
  const lastKey = stepIds[stepIds.length - 1];
  return lastKey ? sessionIds[lastKey] : undefined;
}

function validateParams(
  workflow: Workflow,
  params: Record<string, string>,
): void {
  for (const param of workflow.params) {
    if (param.required && !params[param.name]) {
      if (param.default) {
        params[param.name] = param.default; // nosemgrep: remote-property-injection
      } else {
        throw new Error(`Missing required parameter: ${param.name}`);
      }
    }
  }
}

function resolveStartIndex(workflow: Workflow, from?: string): number {
  if (!from) return 0;
  const index = workflow.steps.findIndex((s) => s.id === from);
  if (index === -1) {
    throw new Error(`Step "${from}" not found in workflow`);
  }
  return index;
}

function resolveStateDir(
  engine: Engine | undefined,
  params: Record<string, string>,
  defaultDir: string,
): string {
  if (engine?.getStateDir) {
    return engine.getStateDir(params);
  }
  return defaultDir;
}

function computeHash(workflowFile: string): string {
  if (!workflowFile) return '';
  try {
    const content = readFileSync(workflowFile, 'utf-8');
    return computeWorkflowHash(content);
  } catch {
    return '';
  }
}

async function defaultPromptUser(message: string): Promise<string> {
  process.stdout.write(message);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf-8');
    stdin.once('data', (data: string) => {
      resolve(data.trim().toLowerCase());
    });
  });
}

/** Handle engine step validation failure with user interaction. */
async function handleValidationFailure(
  step: Step,
  params: Record<string, string>,
  sessionIds: Record<string, string>,
  engine: Engine,
  promptUser: PromptUserFn,
): Promise<boolean> {
  console.log(
    `\nbaton: step "${step.id}" validation failed — expected artifact not found.`,
  );
  const choice = await promptUser(
    '[r] Resume previous session / [q] Exit workflow: ',
  );

  if (choice !== 'r') {
    console.log('\nbaton: workflow stopped.');
    return false;
  }

  const sessionId = sessionIds[step.id];
  if (!sessionId) {
    console.log(
      `\nbaton: cannot resume step "${step.id}" — no session ID recorded. Stopping.`,
    );
    return false;
  }

  console.log(`\nbaton: resuming session ${sessionId}...`);
  const resumeProc = Bun.spawn(['claude', '--resume', sessionId], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await resumeProc.exited;

  if (!engine.validateStep?.(step.id, params)) {
    console.log(
      `\nbaton: step "${step.id}" still failed validation after resume. Stopping.`,
    );
    return false;
  }

  return true;
}

export async function runWorkflow(
  workflow: Workflow,
  params: Record<string, string>,
  options: RunWorkflowOptions = {},
): Promise<void> {
  const {
    from,
    workflowFile = '',
    stateDir: defaultStateDir = process.cwd(),
    engine,
    sessionIds: initialSessionIds,
    promptUser = defaultPromptUser,
  } = options;

  validateParams(workflow, params);

  if (engine?.validateWorkflow) {
    engine.validateWorkflow(workflow, params);
  }

  const startIndex = resolveStartIndex(workflow, from);
  const stateDir = resolveStateDir(engine, params, defaultStateDir);
  const sessionIds: Record<string, string> = initialSessionIds
    ? { ...initialSessionIds }
    : {};
  const workflowHash = computeHash(workflowFile);

  console.log(`\nbaton: running workflow "${workflow.name}"\n`);

  for (let i = startIndex; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (!step) continue;

    const shouldContinue = await executeStep(
      step,
      i,
      workflow,
      params,
      sessionIds,
      workflowFile,
      workflowHash,
      stateDir,
      engine,
      promptUser,
    );
    if (!shouldContinue) return;
  }

  deleteState(stateDir);
  console.log('baton: workflow complete');
}

async function executeStep(
  step: Step,
  index: number,
  workflow: Workflow,
  params: Record<string, string>,
  sessionIds: Record<string, string>,
  workflowFile: string,
  workflowHash: string,
  stateDir: string,
  engine: Engine | undefined,
  promptUser: PromptUserFn,
): Promise<boolean> {
  console.log(
    `--- step ${index + 1}/${workflow.steps.length}: ${step.id} [${step.mode}] ---`,
  );

  const isAgentStep = step.mode !== 'shell';
  const outcome = isAgentStep
    ? await runAgentStep(step, params, sessionIds, engine)
    : await runShellStep(step, params);

  const state: RunState = {
    workflowFile,
    workflowName: workflow.name,
    currentStep: step.id,
    sessionIds,
    params,
    workflowHash,
  };
  writeState(state, stateDir);

  if (outcome === 'aborted') {
    console.log('\nbaton: workflow stopped.');
    return false;
  }

  if (outcome === 'failed') {
    console.log(`\nbaton: step "${step.id}" failed. Stopping.`);
    return false;
  }

  if (isAgentStep && engine?.validateStep) {
    const valid = engine.validateStep(step.id, params);
    if (!valid) {
      const ok = await handleValidationFailure(
        step,
        params,
        sessionIds,
        engine,
        promptUser,
      );
      if (!ok) return false;
    }
  }

  console.log(`--- step "${step.id}" complete ---\n`);
  return true;
}
