import { readFileSync } from 'node:fs';
import { type AuditLogger, buildPrefix, createAuditLogger } from './audit.ts';
import { createRootContext, type ExecutionContext } from './context.ts';
import type { Engine } from './engine.ts';
import {
  executeAgentStep,
  handleValidationFailure,
} from './executors/agent.ts';
import { executeLoopStep, type LoopResult } from './executors/loop.ts';
import { executeShellStep } from './executors/shell.ts';
import { executeSubWorkflowStep } from './executors/sub-workflow.ts';
import type { Step, Workflow } from './schema.ts';
import { shouldSkip } from './shared/flow-control.ts';
import {
  computeWorkflowHash,
  deleteState,
  type NestedStepState,
  type RunState,
  writeState,
} from './state.ts';

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

/** Create crash handler that emits error + run_end before exit. */
function createCrashHandler(
  auditLogger: AuditLogger,
  runStartTime: number,
): (err: unknown) => void {
  return (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    auditLogger.emit({
      timestamp: new Date().toISOString(),
      prefix: '',
      type: 'error',
      data: { message, stack },
    });
    auditLogger.emit({
      timestamp: new Date().toISOString(),
      prefix: '',
      type: 'run_end',
      data: { outcome: 'failed', duration_ms: Date.now() - runStartTime },
    });
    auditLogger.close();
    process.exit(1);
  };
}

/** Emit run_start event with workflow metadata. */
function emitRunStart(
  auditLogger: AuditLogger,
  workflowFile: string,
  workflow: Workflow,
  workflowHash: string,
  params: Record<string, string>,
  from?: string,
): void {
  const data: Record<string, unknown> = {
    workflow_file: workflowFile,
    workflow_name: workflow.name,
    workflow_hash: workflowHash,
    params: { ...params },
  };
  if (from) {
    data.resumed = true;
    data.resume_from = from;
  }
  auditLogger.emit({
    timestamp: new Date().toISOString(),
    prefix: '',
    type: 'run_start',
    data,
  });
}

/** Execute the step loop and return whether the run succeeded. */
async function executeStepLoop(
  workflow: Workflow,
  startIndex: number,
  context: ExecutionContext,
  workflowHash: string,
  stateDir: string,
  promptUser: PromptUserFn,
): Promise<boolean> {
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
  return true;
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

  // Validation happens before audit logger is created -- if validation fails,
  // no audit log file is created (per spec)
  validateParams(workflow, params);
  if (engine?.validateWorkflow) {
    engine.validateWorkflow(workflow, params);
  }

  const startIndex = resolveStartIndex(workflow, from);
  const stateDir = resolveStateDir(engine, params, defaultStateDir);
  const workflowHash = computeHash(workflowFile);

  // Create audit logger after validation succeeds
  const auditLogger = createAuditLogger(workflow.name);
  const runStartTime = Date.now();
  const crashHandler = createCrashHandler(auditLogger, runStartTime);

  process.on('uncaughtException', crashHandler);
  process.on('unhandledRejection', crashHandler);

  const context = createRootContext({
    params,
    workflowFile,
    engine: engine ?? null,
    sessionIds: initialSessionIds,
    capturedVariables: initialCaptured,
    auditLogger,
  });

  emitRunStart(auditLogger, workflowFile, workflow, workflowHash, params, from);
  console.log(`\nbaton: running workflow "${workflow.name}"\n`);

  let runSuccess = false;
  try {
    const loopResult = await executeStepLoop(
      workflow,
      startIndex,
      context,
      workflowHash,
      stateDir,
      promptUser,
    );
    runSuccess = loopResult;
    if (runSuccess) {
      deleteState(stateDir);
      console.log('baton: workflow complete');
    }
    return runSuccess;
  } finally {
    // AuditLogger.emit/close are idempotent -- safe even if crash handler already ran
    auditLogger.emit({
      timestamp: new Date().toISOString(),
      prefix: '',
      type: 'run_end',
      data: {
        outcome: runSuccess ? 'success' : 'failed',
        duration_ms: Date.now() - runStartTime,
      },
    });
    auditLogger.close();
    process.removeListener('uncaughtException', crashHandler);
    process.removeListener('unhandledRejection', crashHandler);
  }
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
    return { outcome: await executeAgentStep(step, context) };
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

    // Emit skipped step events
    const prefix = buildPrefix(context.nestingPath, step.id);
    context.auditLogger?.emit({
      timestamp: new Date().toISOString(),
      prefix,
      type: 'step_start',
      data: {
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
        outcome: 'skipped',
        skip_if: step.skip_if,
        duration_ms: 0,
      },
    });

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
