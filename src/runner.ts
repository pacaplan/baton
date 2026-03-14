import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Subprocess, spawn } from 'bun';
import { interpolateParams } from './loader.ts';
import type { Step, Workflow } from './schema.ts';

const SIGNAL_FILE = '.baton-signal';
const STATE_FILE = '.baton-state.json';
const CLAUDE_SESSIONS_DIR = join(homedir(), '.claude', 'sessions');

type StepOutcome = 'success' | 'failed' | 'aborted';

interface RunState {
  workflowName: string;
  currentStep: number;
  sessionIds: Record<string, string>;
  params: Record<string, string>;
}

function saveState(state: RunState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanSignalFile(): void {
  if (existsSync(SIGNAL_FILE)) {
    unlinkSync(SIGNAL_FILE);
  }
}

function readSessionIdFromPid(pid: number): string | undefined {
  const sessionFile = join(CLAUDE_SESSIONS_DIR, `${pid}.json`);
  try {
    const data = JSON.parse(readFileSync(sessionFile, 'utf-8'));
    return data.sessionId;
  } catch {
    return undefined;
  }
}

async function runShellStep(
  step: Step,
  params: Record<string, string>,
): Promise<StepOutcome> {
  if (!step.command) return 'failed';
  const command = interpolateParams(step.command, params);
  console.log(`  command: ${command}`);

  const proc = spawn(['sh', '-c', command], {
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
  state: RunState,
): Promise<StepOutcome> {
  if (!step.prompt) return 'failed';
  const prompt = interpolateParams(step.prompt, params);
  const args: string[] = ['claude'];

  if (step.session === 'resume') {
    const previousSessionId = findPreviousSessionId(state);
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

  const proc = spawn(args, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const pid = proc.pid;

  let outcome: StepOutcome;
  if (step.mode === 'interactive') {
    outcome = await waitForSignalOrExit(proc);
  } else {
    const exitCode = await proc.exited;
    outcome = exitCode === 0 ? 'success' : 'failed';
  }

  // Capture the real session ID Claude assigned
  const realSessionId = readSessionIdFromPid(pid);
  if (realSessionId) {
    state.sessionIds[step.id] = realSessionId;
    console.log(`  session: ${realSessionId}`);
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
          // Malformed signal — treat as continue
        }
        cleanSignalFile();
        proc.kill('SIGTERM');
        resolve(action === 'continue' ? 'success' : 'aborted');
      }
    }, 500);

    // Process exited without a signal — user quit, don't advance
    proc.exited.then(() => {
      clearInterval(interval);
      cleanSignalFile();
      resolve('aborted');
    });
  });
}

function findPreviousSessionId(state: RunState): string | undefined {
  const stepIds = Object.keys(state.sessionIds);
  if (stepIds.length === 0) return undefined;
  const lastKey = stepIds[stepIds.length - 1];
  return lastKey ? state.sessionIds[lastKey] : undefined;
}

function validateParams(
  workflow: Workflow,
  params: Record<string, string>,
): void {
  for (const param of workflow.params) {
    if (param.required && !params[param.name]) {
      if (param.default) {
        params[param.name] = param.default;
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

export async function runWorkflow(
  workflow: Workflow,
  params: Record<string, string>,
  options: { from?: string } = {},
): Promise<void> {
  validateParams(workflow, params);
  const startIndex = resolveStartIndex(workflow, options.from);

  const state: RunState = {
    workflowName: workflow.name,
    currentStep: startIndex,
    sessionIds: {},
    params,
  };

  console.log(`\nbaton: running workflow "${workflow.name}"\n`);

  for (let i = startIndex; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (!step) continue;

    state.currentStep = i;
    saveState(state);

    console.log(
      `--- step ${i + 1}/${workflow.steps.length}: ${step.id} [${step.mode}] ---`,
    );

    const outcome =
      step.mode === 'shell'
        ? await runShellStep(step, params)
        : await runAgentStep(step, params, state);

    if (outcome === 'aborted') {
      console.log(`\nbaton: workflow stopped.`);
      saveState(state);
      return;
    }

    if (outcome === 'failed') {
      console.log(`\nbaton: step "${step.id}" failed. Stopping.`);
      saveState(state);
      return;
    }

    console.log(`--- step "${step.id}" complete ---\n`);
  }

  if (existsSync(STATE_FILE)) {
    unlinkSync(STATE_FILE);
  }

  console.log('baton: workflow complete');
}
