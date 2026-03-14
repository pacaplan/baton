import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Engine } from '../engine.ts';
import { createEngine } from '../engine.ts';
import { loadWorkflow } from '../loader.ts';
import { runWorkflow } from '../runner.ts';
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

export async function resumeWorkflow(stateFilePath: string): Promise<void> {
  const resolvedPath = resolve(stateFilePath);
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

  // Create engine if workflow has engine config
  let engine: Engine | undefined;
  if (workflow.engine) {
    engine = createEngine(workflow.engine as Record<string, unknown>);
  }

  const stateDir = dirname(resolvedPath);
  const sessionIds = resolveSessionIds(state.currentStep, state.sessionIds);
  const capturedVariables = resolveCapturedVariables(state.currentStep);

  const success = await runWorkflow(workflow, state.params, {
    from: stepId,
    workflowFile,
    stateDir,
    engine,
    sessionIds,
    capturedVariables,
  });

  if (!success) {
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
