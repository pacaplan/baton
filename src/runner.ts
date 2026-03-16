import { readFileSync } from 'node:fs';
import { type AuditLogger, buildPrefix, createAuditLogger } from './audit.ts';
import {
  createRootContext,
  type ExecutionContext,
  type SubWorkflowChildState,
} from './context.ts';
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
  getStateFilePath,
  type NestedStepState,
  type RunState,
  writeState,
} from './state.ts';

type StepOutcome = 'success' | 'failed' | 'aborted';

export enum WorkflowResult {
  Success = 'success',
  Failed = 'failed',
  Stopped = 'stopped',
}

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
  /** Child state for resuming inside a sub-workflow */
  childState?: SubWorkflowChildState | null;
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
  return engine?.getStateDir ? engine.getStateDir(params) : defaultDir;
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

/** Re-run validation that was skipped at startup (e.g. change didn't exist yet). */
function runDeferredValidation(
  workflow: Workflow,
  context: ExecutionContext,
): boolean {
  if (
    !(
      context.engine?.needsDeferredValidation?.() &&
      context.engine.validateWorkflow
    )
  ) {
    return true;
  }
  try {
    context.engine.validateWorkflow(
      workflow,
      context.params,
      context.workflowFile,
    );
    return true;
  } catch (err) {
    console.log(`\nbaton: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Execute the step loop and return the workflow result. */
async function executeStepLoop(
  workflow: Workflow,
  startIndex: number,
  context: ExecutionContext,
  workflowHash: string,
  stateDir: string,
  promptUser: PromptUserFn,
): Promise<WorkflowResult> {
  for (let i = startIndex; i < workflow.steps.length; i++) {
    const step = workflow.steps[i];
    if (!step) continue;

    const stepResult = await dispatchStep(
      step,
      i,
      workflow,
      context,
      workflowHash,
      stateDir,
      promptUser,
    );
    if (stepResult !== 'continue')
      return stepResult === 'stopped'
        ? WorkflowResult.Stopped
        : WorkflowResult.Failed;

    if (
      i === 0 &&
      startIndex === 0 &&
      !runDeferredValidation(workflow, context)
    ) {
      return WorkflowResult.Failed;
    }
  }
  return WorkflowResult.Success;
}

export async function runWorkflow(
  workflow: Workflow,
  params: Record<string, string>,
  options: RunWorkflowOptions = {},
): Promise<WorkflowResult> {
  const {
    from,
    workflowFile = '',
    stateDir: defaultStateDir = process.cwd(),
    engine,
    sessionIds: initialSessionIds,
    capturedVariables: initialCaptured,
    childState,
    promptUser = defaultPromptUser,
  } = options;

  validateParams(workflow, params);
  if (engine?.validateWorkflow) {
    engine.validateWorkflow(workflow, params, workflowFile);
  }

  const startIndex = resolveStartIndex(workflow, from);
  const stateDir = resolveStateDir(engine, params, defaultStateDir);
  const workflowHash = computeHash(workflowFile);
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
  if (childState) context.resumeChildState = childState;
  auditLogger.emit({
    timestamp: new Date().toISOString(),
    prefix: '',
    type: 'run_start',
    data: {
      workflow_file: workflowFile,
      workflow_name: workflow.name,
      workflow_hash: workflowHash,
      context: {
        params: { ...params },
        capturedVariables: { ...context.capturedVariables },
        sessionIds: { ...context.sessionIds },
      },
      ...(from ? { resumed: true, resume_from: from } : {}),
    },
  });
  console.log(`\nbaton: running workflow "${workflow.name}"\n`);

  let result: WorkflowResult = WorkflowResult.Failed;
  try {
    result = await executeStepLoop(
      workflow,
      startIndex,
      context,
      workflowHash,
      stateDir,
      promptUser,
    );
    if (result === WorkflowResult.Success) {
      deleteState(stateDir);
      console.log('baton: workflow complete');
    } else {
      console.log(
        `baton: to resume: baton resume ${getStateFilePath(stateDir)}`,
      );
    }
    return result;
  } finally {
    auditLogger.emit({
      timestamp: new Date().toISOString(),
      prefix: '',
      type: 'run_end',
      data: {
        outcome: result === WorkflowResult.Stopped ? 'stopped' : result,
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

/** Convert SubWorkflowChildState to NestedStepState for serialization. */
function toNestedStepState(child: SubWorkflowChildState): NestedStepState {
  return {
    stepId: child.stepId,
    sessionIds: { ...child.sessionIds },
    capturedVariables: { ...child.capturedVariables },
    child: child.child ? toNestedStepState(child.child) : null,
  };
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
  } else if (context.lastSubWorkflowChild) {
    child = toNestedStepState(context.lastSubWorkflowChild);
    context.lastSubWorkflowChild = undefined;
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

function emitSkippedStepEvents(step: Step, context: ExecutionContext): void {
  const prefix = buildPrefix(context.nestingPath, step.id);
  const ctx = {
    params: { ...context.params },
    capturedVariables: { ...context.capturedVariables },
  };
  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: { context: ctx },
  });
  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_end',
    data: { outcome: 'skipped', skip_if: step.skip_if, duration_ms: 0 },
  });
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
): Promise<'continue' | 'stopped' | 'halt'> {
  if (shouldSkip(step, context)) {
    console.log(
      `--- step ${index + 1}/${workflow.steps.length}: ${step.id} [skipped] ---`,
    );
    emitSkippedStepEvents(step, context);
    return 'continue';
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
  const cont = await handleOutcome(
    result.outcome,
    step,
    stepType,
    context,
    promptUser,
  );
  if (cont) return 'continue';
  return result.outcome === 'aborted' ? 'stopped' : 'halt';
}

type StepType = 'shell' | 'agent' | 'loop' | 'sub-workflow' | 'group';
function getStepType(step: Step): StepType {
  if (step.command) return 'shell';
  if (step.prompt || step.mode === 'interactive' || step.mode === 'headless')
    return 'agent';
  if (step.loop && step.steps) return 'loop';
  if (step.workflow) return 'sub-workflow';
  if (step.steps) return 'group';
  return 'shell';
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
