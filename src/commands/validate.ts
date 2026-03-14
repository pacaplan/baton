import type { Command } from 'commander';
import { createEngine } from '../engine.ts';
import { loadWorkflow } from '../loader.ts';
import type { Workflow } from '../schema.ts';

async function runEngineValidation(
  workflow: Workflow,
  params: Record<string, string>,
  hasRequiredParams: boolean,
): Promise<void> {
  if (!workflow.engine) return;
  const engine = createEngine(workflow.engine as Record<string, unknown>);
  if (!engine.validateWorkflow) return;

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

      const params: Record<string, string> = {};
      for (let i = 0; i < positional.length; i++) {
        const param = workflow.params[i];
        const value = positional[i];
        if (param && value) params[param.name] = value;
      }

      const hasRequiredParams = workflow.params.every(
        (p) => !p.required || params[p.name],
      );

      await runEngineValidation(workflow, params, hasRequiredParams);

      console.log(`Workflow "${workflow.name}" is valid.`);
      console.log(`  ${workflow.steps.length} steps`);
      for (const step of workflow.steps) {
        console.log(`  - ${step.id} [${step.mode}] (session: ${step.session})`);
      }
    });
}
