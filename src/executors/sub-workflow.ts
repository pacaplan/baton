import { dirname, resolve } from 'node:path';
import { buildPrefix } from '../audit.ts';
import type { ExecutionContext, NestingSegment } from '../context.ts';
import { createSubWorkflowContext } from '../context.ts';
import { loadWorkflow } from '../loader.ts';
import type { Step, Workflow } from '../schema.ts';
import { shouldSkip } from '../shared/flow-control.ts';
import { interpolate } from '../shared/interpolation.ts';
import { executeAgentStep } from './agent.ts';
import { executeLoopStep } from './loop.ts';
import { executeShellStep } from './shell.ts';

type StepOutcome = 'success' | 'failed' | 'aborted';

/** Build a prefix string from a nesting path (without appending an extra step). */
function buildNestingPrefix(nestingPath: NestingSegment[]): string {
  const tokens: string[] = [];
  for (const seg of nestingPath) {
    if (seg.iteration === undefined) {
      tokens.push(seg.stepId);
    } else {
      tokens.push(`${seg.stepId}:${seg.iteration}`);
    }
    if (seg.subWorkflowName) {
      tokens.push(`sub:${seg.subWorkflowName}`);
    }
  }
  return `[${tokens.join(', ')}]`;
}

/** Record child step progress on the parent context for state persistence. */
function recordChildProgress(
  childContext: ExecutionContext,
  childStepId: string,
): void {
  const parentCtx = childContext.parentContext;
  if (!parentCtx) return;

  parentCtx.lastSubWorkflowChild = {
    stepId: childStepId,
    sessionIds: { ...childContext.sessionIds },
    capturedVariables: { ...childContext.capturedVariables },
    child: childContext.lastSubWorkflowChild ?? null,
  };
}

/** Execute the child steps of a sub-workflow and return the outcome. */
async function executeChildSteps(
  workflow: Workflow,
  childContext: ExecutionContext,
  startFromStepId?: string,
): Promise<StepOutcome> {
  let reached = !startFromStepId;

  for (const childStep of workflow.steps) {
    if (!reached) {
      if (childStep.id === startFromStepId) {
        reached = true;
      } else {
        continue;
      }
    }

    if (shouldSkip(childStep, childContext)) {
      const prefix = buildPrefix(childContext.nestingPath, childStep.id);
      childContext.auditLogger?.emit({
        timestamp: new Date().toISOString(),
        prefix,
        type: 'step_start',
        data: {
          context: {
            params: { ...childContext.params },
            capturedVariables: { ...childContext.capturedVariables },
          },
        },
      });
      childContext.auditLogger?.emit({
        timestamp: new Date().toISOString(),
        prefix,
        type: 'step_end',
        data: {
          outcome: 'skipped',
          skip_if: childStep.skip_if,
          duration_ms: 0,
        },
      });
      continue;
    }

    // Flush state BEFORE running the step so that if the process is killed
    // mid-step, resume will re-run this step (not an earlier one).
    recordChildProgress(childContext, childStep.id);
    childContext.parentContext?.flushState?.();

    const stepOutcome = await dispatchSubWorkflowChild(childStep, childContext);
    // Update progress with final sessionIds/capturedVariables after completion
    recordChildProgress(childContext, childStep.id);

    if (stepOutcome === 'aborted') {
      return 'aborted';
    }

    childContext.lastStepOutcome = stepOutcome;

    if (stepOutcome === 'failed' && !childStep.continue_on_failure) {
      return 'failed';
    }
  }
  if (startFromStepId && !reached) {
    throw new Error(
      `Resume step "${startFromStepId}" not found in sub-workflow`,
    );
  }
  return 'success';
}

/** Consume resume state from parent and apply to child context. */
function applyResumeState(
  parentContext: ExecutionContext,
  childContext: ExecutionContext,
): string | undefined {
  const resumeChild = parentContext.resumeChildState;
  parentContext.resumeChildState = undefined;
  if (!resumeChild) return undefined;

  Object.assign(childContext.sessionIds, resumeChild.sessionIds);
  Object.assign(childContext.capturedVariables, resumeChild.capturedVariables);
  if (resumeChild.child) {
    childContext.resumeChildState = resumeChild.child;
  }
  return resumeChild.stepId;
}

/**
 * Execute a sub-workflow step.
 *
 * Lazily loads the referenced workflow YAML at execution time,
 * creates a child ExecutionContext with only explicitly passed params,
 * executes the sub-workflow's steps, then discards the child context.
 */
export async function executeSubWorkflowStep(
  step: Step,
  parentContext: ExecutionContext,
): Promise<StepOutcome> {
  if (!step.workflow) return 'failed';

  const prefix = buildPrefix(parentContext.nestingPath, step.id);
  const startTime = Date.now();

  parentContext.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: {
      context: {
        params: { ...parentContext.params },
        capturedVariables: { ...parentContext.capturedVariables },
      },
    },
  });

  let workflowPath: string;
  let workflow: Workflow;
  let resolvedParams: Record<string, string>;
  try {
    workflowPath = resolveWorkflowPath(step.workflow, parentContext);
    workflow = loadWorkflow(workflowPath, { isSubWorkflow: true });
    resolvedParams = resolveParams(step.params, parentContext);
    validateSubWorkflowParams(workflow, resolvedParams);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    parentContext.auditLogger?.emit({
      timestamp: new Date().toISOString(),
      prefix,
      type: 'step_end',
      data: {
        outcome: 'failed',
        error,
        duration_ms: Date.now() - startTime,
      },
    });
    throw err;
  }

  const childContext = createSubWorkflowContext(parentContext, {
    stepId: step.id,
    params: resolvedParams,
    workflowFile: workflowPath,
    subWorkflowName: workflow.name,
  });

  const startFromStepId = applyResumeState(parentContext, childContext);

  const childPrefix = buildNestingPrefix(childContext.nestingPath);
  let outcome: StepOutcome;
  try {
    outcome = await executeSubWorkflowBody(
      workflow,
      workflowPath,
      childContext,
      childPrefix,
      startFromStepId,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    parentContext.auditLogger?.emit({
      timestamp: new Date().toISOString(),
      prefix,
      type: 'step_end',
      data: {
        outcome: 'failed',
        error,
        duration_ms: Date.now() - startTime,
      },
    });
    throw err;
  }

  parentContext.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_end',
    data: {
      outcome,
      duration_ms: Date.now() - startTime,
    },
  });

  return outcome;
}

/** Emit sub_workflow_start, execute child steps, emit sub_workflow_end. */
async function executeSubWorkflowBody(
  workflow: Workflow,
  workflowPath: string,
  childContext: ExecutionContext,
  childPrefix: string,
  startFromStepId?: string,
): Promise<StepOutcome> {
  const subWorkflowStartTime = Date.now();

  childContext.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix: childPrefix,
    type: 'sub_workflow_start',
    data: {
      workflow_name: workflow.name,
      workflow_path: workflowPath,
      context: {
        params: { ...childContext.params },
        capturedVariables: { ...childContext.capturedVariables },
      },
    },
  });

  console.log(`  sub-workflow: ${workflow.name} (${workflowPath})`);

  const outcome = await executeChildSteps(
    workflow,
    childContext,
    startFromStepId,
  );

  childContext.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix: childPrefix,
    type: 'sub_workflow_end',
    data: {
      outcome,
      duration_ms: Date.now() - subWorkflowStartTime,
    },
  });

  return outcome;
}

function resolveWorkflowPath(
  workflowField: string,
  context: ExecutionContext,
): string {
  const interpolated = interpolate(workflowField, context);
  // Resolve relative to the parent workflow's directory
  if (context.workflowFile) {
    const parentDir = dirname(context.workflowFile);
    return resolve(parentDir, interpolated);
  }
  return resolve(interpolated);
}

function resolveParams(
  params: Record<string, string> | undefined,
  context: ExecutionContext,
): Record<string, string> {
  if (!params) return {};
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    resolved[key] = interpolate(value, context);
  }
  return resolved;
}

function validateSubWorkflowParams(
  workflow: {
    params: Array<{ name: string; required: boolean; default?: string }>;
  },
  resolvedParams: Record<string, string>,
): void {
  for (const param of workflow.params) {
    const isMissing = !(param.name in resolvedParams);
    if (isMissing && param.default !== undefined) {
      resolvedParams[param.name] = param.default; // nosemgrep: remote-property-injection
    } else if (isMissing && param.required) {
      throw new Error(`Missing required parameter: ${param.name}`);
    }
  }
}

async function dispatchSubWorkflowChild(
  step: Step,
  context: ExecutionContext,
): Promise<StepOutcome> {
  if (step.command) {
    return executeShellStep(step, context);
  }

  if (step.workflow) {
    return executeSubWorkflowStep(step, context);
  }

  if (step.loop && step.steps) {
    const result = await executeLoopStep(step, context);
    if (result.outcome === 'exhausted') return 'failed';
    return result.outcome === 'success' ? 'success' : 'failed';
  }

  if (step.steps && !step.loop) {
    return executeGroupInSubWorkflow(step.steps, context);
  }

  if (step.prompt || step.mode === 'interactive' || step.mode === 'headless') {
    return executeAgentStep(step, context);
  }

  throw new Error(`Unknown step type in sub-workflow step "${step.id}"`);
}

async function executeGroupInSubWorkflow(
  steps: Step[],
  context: ExecutionContext,
): Promise<StepOutcome> {
  for (const childStep of steps) {
    if (shouldSkip(childStep, context)) {
      continue;
    }

    const outcome = await dispatchSubWorkflowChild(childStep, context);
    if (outcome === 'aborted') {
      return 'aborted';
    }
    context.lastStepOutcome = outcome;
    if (outcome === 'failed' && !childStep.continue_on_failure) {
      return 'failed';
    }
  }
  return 'success';
}
