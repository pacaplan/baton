import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { type Subprocess, spawn } from 'bun';
import { interpolateParams } from './loader.ts';
import type { Step, Workflow } from './schema.ts';

const SIGNAL_FILE = '.baton-signal';
const STATE_FILE = '.baton-state.json';

interface RunState {
  workflowName: string;
  currentStep: number;
  sessionIds: Record<string, string>;
  params: Record<string, string>;
}

function generateSessionId(): string {
  return `baton-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function saveState(state: RunState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanSignalFile(): void {
  if (existsSync(SIGNAL_FILE)) {
    unlinkSync(SIGNAL_FILE);
  }
}

async function runShellStep(
  step: Step,
  params: Record<string, string>,
): Promise<boolean> {
  if (!step.command) return false;
  const command = interpolateParams(step.command, params);
  console.log(`  command: ${command}`);

  const proc = spawn(['sh', '-c', command], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function runAgentStep(
  step: Step,
  params: Record<string, string>,
  state: RunState,
): Promise<boolean> {
  if (!step.prompt) return false;
  const prompt = interpolateParams(step.prompt, params);
  const args: string[] = ['claude'];

  if (step.session === 'resume') {
    const previousSessionId = findPreviousSessionId(state);
    if (previousSessionId) {
      args.push('--resume', previousSessionId);
    }
  }

  const sessionId = generateSessionId();
  state.sessionIds[step.id] = sessionId;
  args.push('--session-id', sessionId);

  if (step.mode === 'headless') {
    args.push('-p');
  }

  args.push(prompt);

  console.log(`  session: ${sessionId}`);
  console.log(`  mode: ${step.mode}`);

  if (step.mode === 'interactive') {
    console.log('  (type /continue when done)\n');
  }

  cleanSignalFile();

  const proc = spawn(args, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (step.mode === 'interactive') {
    return waitForSignalOrExit(proc);
  }

  const exitCode = await proc.exited;
  return exitCode === 0;
}

async function waitForSignalOrExit(proc: Subprocess): Promise<boolean> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (existsSync(SIGNAL_FILE)) {
        clearInterval(interval);
        cleanSignalFile();
        proc.kill('SIGTERM');
        resolve(true);
      }
    }, 500);

    proc.exited.then((code) => {
      clearInterval(interval);
      resolve(code === 0);
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

    const success =
      step.mode === 'shell'
        ? await runShellStep(step, params)
        : await runAgentStep(step, params, state);

    if (!success) {
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
