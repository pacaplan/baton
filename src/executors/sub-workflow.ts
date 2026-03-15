import { dirname, resolve } from 'node:path';
import type { ExecutionContext } from '../context.ts';
import { createSubWorkflowContext } from '../context.ts';
import { loadWorkflow } from '../loader.ts';
import type { Step, Workflow } from '../schema.ts';
import { shouldSkip } from '../shared/flow-control.ts';
import { interpolate } from '../shared/interpolation.ts';
import { executeAgentStep } from './agent.ts';
import { executeLoopStep } from './loop.ts';
import { executeShellStep } from './shell.ts';

type StepOutcome = 'success' | 'failed';

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

  // Resolve params: interpolate values using parent context
  const resolvedParams = resolveParams(step.params, parentContext);

  // Validate required params
  validateSubWorkflowParams(workflow, resolvedParams);

  // Create child context — only explicit params, no parent inheritance
  const childContext = createSubWorkflowContext(parentContext, {
    stepId: step.id,
    params: resolvedParams,
    workflowFile: workflowPath,
  });

  console.log(`  sub-workflow: ${workflow.name} (${workflowPath})`);

  // Execute each step in the sub-workflow
  for (const childStep of workflow.steps) {
    if (shouldSkip(childStep, childContext)) {
      continue;
    }

    const outcome = await dispatchSubWorkflowChild(childStep, childContext);

    childContext.lastStepOutcome = outcome;

    if (outcome === 'failed' && !childStep.continue_on_failure) {
      return 'failed';
    }
  }

  return 'success';
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
