import type { Command } from 'commander';
import { createEngine } from '../engine.ts';
import { loadWorkflow } from '../loader.ts';
import type { Step, Workflow } from '../schema.ts';

function getStepTypeLabel(step: Step): string {
  if (step.command) return step.mode ?? 'shell';
  if (step.prompt) return step.mode ?? 'agent';
  if (step.loop && step.steps) return 'loop';
  if (step.workflow) return 'sub-workflow';
  if (step.steps) return 'group';
  return 'unknown';
}

function parsePositionalParams(
  workflow: Workflow,
  positional: string[],
): Record<string, string> {
  const params: Record<string, string> = {};
  for (let i = 0; i < positional.length; i++) {
    const param = workflow.params[i];
    const value = positional[i];
    if (param && value) params[param.name] = value;
  }
  return params;
}

async function validateEngine(
  workflow: Workflow,
  params: Record<string, string>,
): Promise<void> {
  if (!workflow.engine) return;

  const engine = createEngine(workflow.engine as Record<string, unknown>);
  if (!engine.validateWorkflow) return;

  const hasRequiredParams = workflow.params.every(
    (p) => !p.required || params[p.name],
  );

  if (hasRequiredParams) {
    await engine.validateWorkflow(workflow, params);
  } else {
    console.log(
      '  (skipping engine validation — required params not provided)',
    );
  }
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate a workflow YAML file')
    .argument('<workflow>', 'Path to workflow YAML file')
    .argument('[params...]', 'Positional parameters for the workflow')
    .action(async (file: string, positional: string[]) => {
      const workflow = loadWorkflow(file);
      const params = parsePositionalParams(workflow, positional);
      await validateEngine(workflow, params);

      console.log(`Workflow "${workflow.name}" is valid.`);
      console.log(`  ${workflow.steps.length} steps`);
      for (const step of workflow.steps) {
        const type = getStepTypeLabel(step);
        console.log(`  - ${step.id} [${type}] (session: ${step.session})`);
      }
    });
}
