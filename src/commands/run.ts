import { resolve } from 'node:path';
import type { Command } from 'commander';
import type { Engine } from '../engine.ts';
import { createEngine } from '../engine.ts';
import { loadWorkflow } from '../loader.ts';
import { runWorkflow, WorkflowResult } from '../runner.ts';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a workflow')
    .argument('<workflow>', 'Path to workflow YAML file')
    .argument('[params...]', 'Positional parameters for the workflow')
    .option('--from <step>', 'Start from a specific step')
    .option(
      '--session <id>',
      'Resume an existing Claude session for the first step',
    )
    .action(
      async (
        file: string,
        positional: string[],
        options: { from?: string; session?: string },
      ) => {
        const workflow = loadWorkflow(file);
        const params: Record<string, string> = {};
        for (let i = 0; i < positional.length; i++) {
          const param = workflow.params[i];
          const value = positional[i];
          if (param && value) params[param.name] = value;
        }

        let engine: Engine | undefined;
        if (workflow.engine) {
          engine = createEngine(workflow.engine as Record<string, unknown>);
        }

        const sessionIds = options.session
          ? { _seed: options.session }
          : undefined;

        const result = await runWorkflow(workflow, params, {
          from: options.from,
          workflowFile: resolve(file),
          engine,
          sessionIds,
        });

        if (result === WorkflowResult.Failed) {
          process.exit(1);
        }
      },
    );
}
