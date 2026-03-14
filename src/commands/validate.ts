import type { Command } from 'commander';
import { createEngine } from '../engine.ts';
import { loadWorkflow } from '../loader.ts';

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

      if (workflow.engine) {
        const engine = createEngine(workflow.engine as Record<string, unknown>);
        if (engine.validateWorkflow) {
          await engine.validateWorkflow(workflow, params);
        }
      }

      console.log(`Workflow "${workflow.name}" is valid.`);
      console.log(`  ${workflow.steps.length} steps`);
      for (const step of workflow.steps) {
        console.log(`  - ${step.id} [${step.mode}] (session: ${step.session})`);
      }
    });
}
