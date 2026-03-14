import type { Command } from 'commander';
import { loadWorkflow } from '../loader.ts';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate a workflow YAML file')
    .argument('<workflow>', 'Path to workflow YAML file')
    .action((file: string) => {
      const workflow = loadWorkflow(file);
      console.log(`Workflow "${workflow.name}" is valid.`);
      console.log(`  ${workflow.steps.length} steps`);
      for (const step of workflow.steps) {
        console.log(`  - ${step.id} [${step.mode}] (session: ${step.session})`);
      }
    });
}
