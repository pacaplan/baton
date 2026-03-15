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

type StepOutcome = 'success' | 'failed';

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

/** Execute the child steps of a sub-workflow and return the outcome. */
async function executeChildSteps(
  workflow: Workflow,
  childContext: ExecutionContext,
): Promise<StepOutcome> {
  for (const childStep of workflow.steps) {
    if (shouldSkip(childStep, childContext)) {
      continue;
    }

    const stepOutcome = await dispatchSubWorkflowChild(childStep, childContext);

    childContext.lastStepOutcome = stepOutcome;

    if (stepOutcome === 'failed' && !childStep.continue_on_failure) {
      return 'failed';
    }
  }
  return 'success';
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

  const workflowPath = resolveWorkflowPath(step.workflow, parentContext);

  let workflow: Workflow;
  try {
    workflow = loadWorkflow(workflowPath, { isSubWorkflow: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Sub-workflow "${step.id}": failed to load "${workflowPath}": ${msg}`,
    );
  }

  const resolvedParams = resolveParams(step.params, parentContext);
  validateSubWorkflowParams(workflow, resolvedParams);

  const prefix = buildPrefix(parentContext.nestingPath, step.id);
  const startTime = Date.now();

  parentContext.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: {
      workflow_path: workflowPath,
      params: { ...resolvedParams },
      context: {
        params: { ...parentContext.params },
        capturedVariables: { ...parentContext.capturedVariables },
      },
    },
  });

  const childContext = createSubWorkflowContext(parentContext, {
    stepId: step.id,
    params: resolvedParams,
    workflowFile: workflowPath,
    subWorkflowName: workflow.name,
  });

  const childPrefix = buildNestingPrefix(childContext.nestingPath);
  const outcome = await executeSubWorkflowBody(
    workflow,
    workflowPath,
    childContext,
    childPrefix,
  );

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

  const outcome = await executeChildSteps(workflow, childContext);

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
    const outcome = await executeAgentStep(step, context);
    return outcome === 'aborted' ? 'failed' : outcome;
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
    context.lastStepOutcome = outcome;
    if (outcome === 'failed' && !childStep.continue_on_failure) {
      return 'failed';
    }
  }
  return 'success';
}
