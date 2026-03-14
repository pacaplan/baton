import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import { createRootContext, type ExecutionContext } from './context.ts';
import type { Engine } from './engine.ts';
import { executeLoopStep, type LoopResult } from './executors/loop.ts';
import { executeShellStep } from './executors/shell.ts';
import { executeSubWorkflowStep } from './executors/sub-workflow.ts';
import type { Step, Workflow } from './schema.ts';
import { shouldSkip } from './shared/flow-control.ts';
import { interpolate } from './shared/interpolation.ts';
import {
  computeWorkflowHash,
  deleteState,
  type NestedStepState,
  type RunState,
  writeState,
} from './state.ts';

const SIGNAL_FILE = '.baton-signal';

type StepOutcome = 'success' | 'failed' | 'aborted';
type PromptUserFn = (message: string) => Promise<string>;

interface StepExecutionResult {
  outcome: StepOutcome;
  loopResult?: LoopResult;
}

export interface RunWorkflowOptions {
  from?: string;
  workflowFile?: string;
  stateDir?: string;
  engine?: Engine;
  sessionIds?: Record<string, string>;
  capturedVariables?: Record<string, string>;
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
 */
function findConversationId(
  cwd: string,
  startTime: number,
): string | undefined {
  const encodedCwd = resolve(cwd).replace(/[/.]/g, '-');
  const projectDir = join(homedir(), '.claude', 'projects', encodedCwd);

  if (!existsSync(projectDir)) return undefined;

  let bestFile: string | undefined;
  let bestMtime = 0;

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!(entry.isFile() && entry.name.endsWith('.jsonl'))) continue;
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

export async function runWorkflow(
  workflow: Workflow,
  params: Record<string, string>,
  options: RunWorkflowOptions = {},
): Promise<boolean> {
  const {
    from,
    workflowFile = '',
    stateDir: defaultStateDir = process.cwd(),
    engine,
    sessionIds: initialSessionIds,
    capturedVariables: initialCaptured,
    promptUser = defaultPromptUser,
  } = options;

  validateParams(workflow, params);

  if (engine?.validateWorkflow) {
    engine.validateWorkflow(workflow, params);
  }

  const startIndex = resolveStartIndex(workflow, from);
  const stateDir = resolveStateDir(engine, params, defaultStateDir);
  const workflowHash = computeHash(workflowFile);

  const context = createRootContext({
    params,
    workflowFile,
    engine: engine ?? null,
    sessionIds: initialSessionIds,
    capturedVariables: initialCaptured,
  });

  console.log(`\nbaton: running workflow "${workflow.name}"\n`);

  for (let i = startIndex; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (!step) continue;

    const shouldContinue = await dispatchStep(
      step,
      i,
      workflow,
      context,
      workflowHash,
      stateDir,
      promptUser,
    );
    if (!shouldContinue) return false;
  }

  deleteState(stateDir);
  console.log('baton: workflow complete');
  return true;
}

/** Route a step to the correct executor based on its type. */
async function executeByType(
  step: Step,
  stepType: string,
  context: ExecutionContext,
): Promise<StepExecutionResult> {
  if (stepType === 'shell') {
    return { outcome: await executeShellStep(step, context) };
  }
  if (stepType === 'agent') {
    return { outcome: await runAgentStep(step, context) };
  }
  if (stepType === 'loop') {
    const loopResult = await executeLoopStep(step, context);
    let outcome: StepOutcome = 'failed';
    if (loopResult.outcome === 'success') {
      outcome = 'success';
    }
    return { outcome, loopResult };
  }
  if (stepType === 'sub-workflow') {
    return { outcome: await executeSubWorkflowStep(step, context) };
  }
  if (stepType === 'group') {
    return { outcome: await executeGroupStepInRunner(step, context) };
  }
  throw new Error(`Unknown step type for step "${step.id}"`);
}

/** Persist state after step execution. */
function writeStepState(
  step: Step,
  context: ExecutionContext,
  workflow: Workflow,
  workflowHash: string,
  stateDir: string,
  loopResult?: LoopResult,
): void {
  let child: NestedStepState | null = null;

  if (loopResult && loopResult.lastIteration >= 0) {
    child = {
      stepId: `${step.id}:iteration`,
      sessionIds: {},
      capturedVariables: {
        _iteration: String(loopResult.lastIteration),
      },
      child: null,
    };
  }

  const nestedState: NestedStepState = {
    stepId: step.id,
    sessionIds: { ...context.sessionIds },
    capturedVariables: { ...context.capturedVariables },
    child,
  };
  const state: RunState = {
    workflowFile: context.workflowFile,
    workflowName: workflow.name,
    currentStep: nestedState,
    params: context.params,
    workflowHash,
  };
  writeState(state, stateDir);
}

/** Handle step outcome and return whether the workflow should continue. */
async function handleOutcome(
  outcome: StepOutcome,
  step: Step,
  stepType: string,
  context: ExecutionContext,
  promptUser: PromptUserFn,
): Promise<boolean> {
  if (outcome === 'aborted') {
    console.log('\nbaton: workflow stopped.');
    return false;
  }

  if (outcome === 'failed') {
    context.lastStepOutcome = 'failed';
    if (step.continue_on_failure) {
      console.log(`--- step "${step.id}" failed (continue_on_failure) ---\n`);
      return true;
    }
    console.log(`\nbaton: step "${step.id}" failed. Stopping.`);
    return false;
  }

  context.lastStepOutcome = 'success';

  if (stepType === 'agent' && context.engine?.validateStep) {
    const valid = context.engine.validateStep(step.id, context.params);
    if (!valid) {
      const ok = await handleValidationFailure(step, context, promptUser);
      if (!ok) return false;
    }
  }

  console.log(`--- step "${step.id}" complete ---\n`);
  return true;
}

/** Determine the step type and route to the appropriate executor. */
async function dispatchStep(
  step: Step,
  index: number,
  workflow: Workflow,
  context: ExecutionContext,
  workflowHash: string,
  stateDir: string,
  promptUser: PromptUserFn,
): Promise<boolean> {
  if (shouldSkip(step, context)) {
    console.log(
      `--- step ${index + 1}/${workflow.steps.length}: ${step.id} [skipped] ---`,
    );
    return true;
  }

  const stepType = getStepType(step);
  console.log(
    `--- step ${index + 1}/${workflow.steps.length}: ${step.id} [${stepType}] ---`,
  );

  const result = await executeByType(step, stepType, context);
  writeStepState(
    step,
    context,
    workflow,
    workflowHash,
    stateDir,
    result.loopResult,
  );
  return handleOutcome(result.outcome, step, stepType, context, promptUser);
}

function getStepType(
  step: Step,
): 'shell' | 'agent' | 'loop' | 'sub-workflow' | 'group' {
  if (step.command) return 'shell';
  if (step.prompt || step.mode === 'interactive' || step.mode === 'headless') {
    return 'agent';
  }
  if (step.loop && step.steps) return 'loop';
  if (step.workflow) return 'sub-workflow';
  if (step.steps) return 'group';
  return 'shell'; // fallback
}

async function executeGroupStepInRunner(
  step: Step,
  context: ExecutionContext,
): Promise<StepOutcome> {
  if (!step.steps) return 'failed';
  for (const child of step.steps) {
    const childType = getStepType(child);
    const result = await executeByType(child, childType, context);
    if (result.outcome === 'aborted') {
      return 'aborted';
    }
    context.lastStepOutcome = result.outcome;
    if (result.outcome === 'failed' && !child.continue_on_failure) {
      return 'failed';
    }
  }
  return 'success';
}

async function runAgentStep(
  step: Step,
  context: ExecutionContext,
): Promise<StepOutcome> {
  if (!step.prompt) return 'failed';
  let prompt = interpolate(step.prompt, context);

  if (context.engine?.enrichPrompt) {
    const enrichment = context.engine.enrichPrompt(step.id, context.params);
    if (enrichment) {
      prompt = `${prompt}\n\n${enrichment}`;
    }
  }

  const args: string[] = ['claude'];

  if (step.session === 'resume') {
    const previousSessionId = findPreviousSessionId(context.sessionIds);
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
    context.sessionIds[step.id] = conversationId;
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

async function handleValidationFailure(
  step: Step,
  context: ExecutionContext,
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

  const sessionId = context.sessionIds[step.id];
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

  if (!context.engine?.validateStep?.(step.id, context.params)) {
    console.log(
      `\nbaton: step "${step.id}" still failed validation after resume. Stopping.`,
    );
    return false;
  }

  return true;
}
