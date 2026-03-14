import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import type { Engine } from '../engine.ts';
import { createEngine } from '../engine.ts';
import { loadWorkflow } from '../loader.ts';
import { runWorkflow } from '../runner.ts';
import { computeWorkflowHash, readState } from '../state.ts';

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

  // Verify currentStep still exists
  const stepIndex = workflow.steps.findIndex((s) => s.id === state.currentStep);
  if (stepIndex === -1) {
    throw new Error(
      `Step "${state.currentStep}" not found in workflow "${workflowFile}"`,
    );
  }

  // Create engine if workflow has engine config
  let engine: Engine | undefined;
  if (workflow.engine) {
    engine = createEngine(workflow.engine as Record<string, unknown>);
  }

  const stateDir = dirname(resolvedPath);

  await runWorkflow(workflow, state.params, {
    from: state.currentStep,
    workflowFile,
    stateDir,
    engine,
    sessionIds: state.sessionIds,
  });
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
