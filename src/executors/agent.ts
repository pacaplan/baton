import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import type { ExecutionContext } from '../context.ts';
import type { Step } from '../schema.ts';
import { interpolate } from '../shared/interpolation.ts';
import {
  resolveInheritSession,
  resolveResumeSession,
} from '../shared/session.ts';

type StepOutcome = 'success' | 'failed' | 'aborted';

const SIGNAL_FILE = '.baton-signal';

function cleanSignalFile(): void {
  if (existsSync(SIGNAL_FILE)) {
    unlinkSync(SIGNAL_FILE);
  }
}

/**
 * Execute an agent step (headless or interactive).
 *
 * Handles prompt interpolation, engine enrichment, session resolution,
 * model override, signal file polling (interactive), SIGINT handling
 * (headless), and conversation ID discovery.
 */
export async function executeAgentStep(
  step: Step,
  context: ExecutionContext,
): Promise<StepOutcome> {
  if (!step.prompt) return 'failed';

  const prompt = buildPrompt(step, context);
  const args = buildArgs(step, prompt, context);

  logStepMode(step);
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
    outcome = await runHeadlessWithSigint(proc);
  }

  discoverAndStoreSession(step, context, spawnTime);
  return outcome;
}

/** Build the final prompt with interpolation and engine enrichment. */
function buildPrompt(step: Step, context: ExecutionContext): string {
  let prompt = interpolate(step.prompt ?? '', context);

  if (context.engine?.enrichPrompt) {
    const enrichment = context.engine.enrichPrompt(step.id, context.params);
    if (enrichment) {
      prompt = `${prompt}\n\n${enrichment}`;
    }
  }

  return prompt;
}

/** Build the claude invocation args. */
function buildArgs(
  step: Step,
  prompt: string,
  context: ExecutionContext,
): string[] {
  const args: string[] = ['claude'];

  // Session resolution
  const sessionId = resolveSessionId(step, context);
  if (sessionId) {
    args.push('--resume', sessionId);
  }

  // Model override
  if (step.model) {
    args.push('--model', step.model);
  }

  // Headless flag
  if (step.mode === 'headless') {
    args.push('-p');
  }

  args.push(prompt);
  return args;
}

/** Resolve session ID based on the step's session strategy. */
function resolveSessionId(
  step: Step,
  context: ExecutionContext,
): string | undefined {
  if (step.session === 'resume') {
    try {
      return resolveResumeSession(context);
    } catch {
      return undefined;
    }
  }

  if (step.session === 'inherit') {
    try {
      return resolveInheritSession(context);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function logStepMode(step: Step): void {
  console.log(`  mode: ${step.mode}`);
  if (step.mode === 'interactive') {
    console.log('  (/continue to advance, exit to stop)\n');
  }
}

/**
 * Run a headless subprocess with SIGINT handling.
 * Registers a handler before spawn, removes it after exit.
 */
async function runHeadlessWithSigint(proc: Subprocess): Promise<StepOutcome> {
  const sigintHandler = () => {
    proc.kill();
  };

  process.on('SIGINT', sigintHandler);

  try {
    const exitCode = await proc.exited;
    return exitCode === 0 ? 'success' : 'failed';
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
}

/** Interactive mode: poll .baton-signal file, or wait for process exit. */
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

/**
 * Find the conversation ID for a claude session spawned from cwd.
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

/** Discover conversation ID and store in context. */
function discoverAndStoreSession(
  step: Step,
  context: ExecutionContext,
  spawnTime: number,
): void {
  const conversationId = findConversationId(process.cwd(), spawnTime);
  if (conversationId) {
    context.sessionIds[step.id] = conversationId;
    console.log(`  session: ${conversationId}`);
  }
}

/**
 * Handle validation failure by prompting user to resume or exit.
 * Exported for use by runner.ts.
 */
export async function handleValidationFailure(
  step: Step,
  context: ExecutionContext,
  promptUser: (message: string) => Promise<string>,
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
