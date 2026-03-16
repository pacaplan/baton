import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import type { Engine } from '../engine.ts';
import { createEngine } from '../engine.ts';
import { loadWorkflow } from '../loader.ts';
import { runWorkflow, WorkflowResult } from '../runner.ts';
import type { Workflow } from '../schema.ts';
import type { NestedStepState } from '../state.ts';
import { computeWorkflowHash, readState } from '../state.ts';

function resolveStepId(currentStep: string | NestedStepState): string {
  if (typeof currentStep === 'string') return currentStep;
  return currentStep.stepId;
}

function resolveSessionIds(
  currentStep: string | NestedStepState,
  legacySessionIds?: Record<string, string>,
): Record<string, string> {
  if (typeof currentStep === 'string') {
    return legacySessionIds ?? {};
  }
  return currentStep.sessionIds;
}

function resolveCapturedVariables(
  currentStep: string | NestedStepState,
): Record<string, string> {
  if (typeof currentStep === 'string') return {};
  return currentStep.capturedVariables;
}

/**
 * Validate nested sub-workflow state chain.
 * Walks the child chain, loading sub-workflow files and
 * verifying that each recorded step ID still exists.
 */
function validateNestedState(
  nestedState: NestedStepState,
  workflow: Workflow,
  workflowFile: string,
): void {
  if (!nestedState.child) return;

  // Find the step in the current workflow
  const step = workflow.steps.find((s) => s.id === nestedState.stepId);
  if (!step) return; // Top-level validation already catches this

  // If it's a sub-workflow step, validate the child chain
  if (step.workflow) {
    const parentDir = dirname(workflowFile);
    const subPath = resolvePath(parentDir, step.workflow);
    let subWorkflow: Workflow;
    try {
      subWorkflow = loadWorkflow(subPath, { isSubWorkflow: true });
    } catch {
      throw new Error(
        `Sub-workflow file "${subPath}" could not be loaded ` +
          `for resume validation`,
      );
    }

    const childStepId = nestedState.child.stepId;
    const childExists = subWorkflow.steps.some((s) => s.id === childStepId);
    if (!childExists) {
      throw new Error(
        `Step "${childStepId}" not found in sub-workflow ` +
          `"${subPath}" — the workflow file may have changed`,
      );
    }

    // Recurse for deeper nesting
    validateNestedState(nestedState.child, subWorkflow, subPath);
  }
}

export async function resumeWorkflow(stateFilePath: string): Promise<void> {
  const resolvedPath = resolvePath(stateFilePath);
  const state = readState(resolvedPath);

  const workflowFile = state.workflowFile;
  const workflow = loadWorkflow(workflowFile);

  // Check if workflow file has changed
  const currentContent = readFileSync(workflowFile, 'utf-8');
  const currentHash = computeWorkflowHash(currentContent);
  if (currentHash !== state.workflowHash) {
    console.warn(
      'baton: warning — workflow file has changed since state was written',
    );
  }

  const stepId = resolveStepId(state.currentStep);

  // Verify currentStep still exists
  const stepIndex = workflow.steps.findIndex((s) => s.id === stepId);
  if (stepIndex === -1) {
    throw new Error(`Step "${stepId}" not found in workflow "${workflowFile}"`);
  }

  // Validate nested sub-workflow state if present
  if (typeof state.currentStep !== 'string') {
    validateNestedState(state.currentStep, workflow, workflowFile);
  }

  // Create engine if workflow has engine config
  let engine: Engine | undefined;
  if (workflow.engine) {
    engine = createEngine(workflow.engine as Record<string, unknown>);
  }

  const stateDir = dirname(resolvedPath);
  const sessionIds = resolveSessionIds(state.currentStep, state.sessionIds);
  const capturedVariables = resolveCapturedVariables(state.currentStep);
  const childState =
    typeof state.currentStep === 'string' ? null : state.currentStep.child;

  const result = await runWorkflow(workflow, state.params, {
    from: stepId,
    workflowFile,
    stateDir,
    engine,
    sessionIds,
    capturedVariables,
    childState,
  });

  if (result === WorkflowResult.Failed) {
    process.exit(1);
  }
}

export function registerResumeCommand(program: Command): void {
  program
    .command('resume')
    .description('Resume a workflow from a state file')
    .argument('<state-file>', 'Path to baton-state.json')
    .action(async (stateFile: string) => {
      await resumeWorkflow(stateFile);
    });
}
