import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import ora from 'ora';
import { buildPrefix } from '../audit.ts';
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

  const prefix = buildPrefix(context.nestingPath, step.id);
  const startTime = Date.now();
  const mode = step.mode ?? 'interactive';

  let prompt: string;
  let enrichment: string | undefined;
  let sessionId: string | undefined;

  try {
    const built = buildPrompt(step, context);
    prompt = built.prompt;
    enrichment = built.enrichment;
    sessionId = resolveSessionId(step, context);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitAgentStartEnd(context, prefix, startTime, mode, step, {
      outcome: 'failed',
      error,
    });
    return 'failed';
  }

  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: {
      prompt,
      mode,
      session_strategy: step.session ?? 'new',
      resolved_session_id: sessionId,
      model: step.model,
      enrichment,
      context: {
        params: { ...context.params },
        capturedVariables: { ...context.capturedVariables },
      },
    },
  });

  const args = buildArgsFromResolved(step, prompt, sessionId);
  logStepMode(step);
  logHeadlessPrompt(step, prompt);
  cleanSignalFile();

  const spawnTime = Date.now();
  const proc = Bun.spawn(args, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  let outcome: StepOutcome;
  let exitCode: number;
  if (step.mode === 'headless') {
    const headlessResult = await runHeadlessWithSigint(proc);
    outcome = headlessResult.outcome;
    exitCode = headlessResult.exitCode;
  } else {
    const interactiveResult = await waitForSignalOrExit(proc);
    outcome = interactiveResult.outcome;
    exitCode = interactiveResult.exitCode;
  }

  const discoveredSessionId = discoverAndStoreSession(step, context, spawnTime);

  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_end',
    data: {
      exit_code: exitCode,
      discovered_session_id: discoveredSessionId,
      outcome,
      duration_ms: Date.now() - startTime,
    },
  });

  return outcome;
}

/** Emit paired step_start/step_end for early failures (prompt build, etc). */
function emitAgentStartEnd(
  context: ExecutionContext,
  prefix: string,
  startTime: number,
  mode: string,
  step: Step,
  result: { outcome: StepOutcome; error: string },
): void {
  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: {
      mode,
      session_strategy: step.session ?? 'new',
      context: {
        params: { ...context.params },
        capturedVariables: { ...context.capturedVariables },
      },
    },
  });
  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_end',
    data: {
      outcome: result.outcome,
      error: result.error,
      duration_ms: Date.now() - startTime,
    },
  });
}

/** Build the final prompt with interpolation and engine enrichment. */
function buildPrompt(
  step: Step,
  context: ExecutionContext,
): { prompt: string; enrichment: string | undefined } {
  let prompt = interpolate(step.prompt ?? '', context);
  let enrichment: string | undefined;

  if (context.engine?.enrichPrompt) {
    const result = context.engine.enrichPrompt(step.id, context.params, {
      sessionStrategy: step.session,
    });
    if (result) {
      enrichment = result;
      prompt = `${prompt}\n\n${enrichment}`;
    }
  }

  return { prompt, enrichment };
}

/** Build the claude invocation args from pre-resolved values. */
function buildArgsFromResolved(
  step: Step,
  prompt: string,
  sessionId: string | undefined,
): string[] {
  const args: string[] = ['claude'];

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
  const mode = step.mode ?? 'interactive';
  console.log(`  mode: ${mode}`);
  if (mode !== 'headless') {
    console.log('  (/continue to advance, exit to stop)\n');
  }
}

/** Print the resolved prompt (indented) for headless steps when opted in. */
function logHeadlessPrompt(step: Step, prompt: string): void {
  if (step.mode === 'headless' && process.env.BATON_SHOW_PROMPT === '1') {
    console.log(
      prompt
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }
}

/**
 * Run a headless subprocess with SIGINT handling.
 * Registers a handler before spawn, removes it after exit.
 */
async function runHeadlessWithSigint(
  proc: Subprocess,
): Promise<{ outcome: StepOutcome; exitCode: number }> {
  const spinner = ora('agent running...').start();

  const sigintHandler = () => {
    spinner.stop();
    proc.kill();
  };

  process.on('SIGINT', sigintHandler);

  try {
    const exitCode = await proc.exited;
    return { outcome: exitCode === 0 ? 'success' : 'failed', exitCode };
  } finally {
    spinner.stop();
    process.removeListener('SIGINT', sigintHandler);
  }
}

/** Read the signal file action, defaulting to 'continue' on parse failure. */
function readSignalAction(): string {
  try {
    const raw = readFileSync(SIGNAL_FILE, 'utf-8').trim();
    const signal = JSON.parse(raw);
    return signal.action ?? 'continue';
  } catch {
    // Malformed signal -- treat as continue
    return 'continue';
  }
}

/** Interactive mode: poll .baton-signal file, or wait for process exit. */
async function waitForSignalOrExit(
  proc: Subprocess,
): Promise<{ outcome: StepOutcome; exitCode: number }> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (existsSync(SIGNAL_FILE)) {
        clearInterval(interval);
        const action = readSignalAction();
        cleanSignalFile();
        proc.kill('SIGTERM');
        // Signal-based exit: use 0 for continue, 1 for abort
        resolve({
          outcome: action === 'continue' ? 'success' : 'aborted',
          exitCode: action === 'continue' ? 0 : 1,
        });
      }
    }, 500);

    proc.exited.then((exitCode) => {
      clearInterval(interval);
      cleanSignalFile();
      resolve({ outcome: 'aborted', exitCode });
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
  const encodedCwd = resolve(cwd).replace(/[/._]/g, '-');
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

/** Discover conversation ID and store in context. Returns discovered ID or undefined. */
function discoverAndStoreSession(
  step: Step,
  context: ExecutionContext,
  spawnTime: number,
): string | undefined {
  const conversationId = findConversationId(process.cwd(), spawnTime);
  if (conversationId) {
    context.sessionIds[step.id] = conversationId;
    console.log(`  session: ${conversationId}`);
  }
  return conversationId;
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
