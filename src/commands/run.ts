import type { Command } from 'commander';
import { loadWorkflow } from '../loader.ts';
import { runWorkflow } from '../runner.ts';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a workflow')
    .argument('<workflow>', 'Path to workflow YAML file')
    .argument('[params...]', 'Positional parameters for the workflow')
    .option('--from <step>', 'Start from a specific step')
    .action(
      async (
        file: string,
        positional: string[],
        options: { from?: string },
      ) => {
        const workflow = loadWorkflow(file);
        const params: Record<string, string> = {};
        for (let i = 0; i < positional.length; i++) {
          const param = workflow.params[i];
          const value = positional[i];
          if (param && value) params[param.name] = value;
        }
        await runWorkflow(workflow, params, { from: options.from });
      },
    );
}
