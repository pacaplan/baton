import { loadWorkflow } from './loader.ts';
import { runWorkflow } from './runner.ts';

function usage(): string {
  return [
    'Usage: baton <command> [options]',
    '',
    'Commands:',
    '  run <workflow.yaml> [param1 param2 ...] [--from step-id]',
    '  validate <workflow.yaml>',
    '',
    'Examples:',
    '  baton run workflows/flokay.yaml add-auth',
    '  baton run workflows/flokay.yaml --from implement',
    '  baton validate workflows/flokay.yaml',
  ].join('\n');
}

function parseArgs(args: string[]): {
  command: string;
  file: string;
  positional: string[];
  from?: string;
} {
  const [command, file, ...rest] = args;

  if (!(command && file)) {
    console.log(usage());
    process.exit(1);
  }

  const positional: string[] = [];
  let from: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const nextArg = rest[i + 1];
    if (arg === '--from' && nextArg) {
      from = nextArg;
      i++;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  return { command, file, positional, from };
}

export async function main(args: string[]): Promise<number> {
  const { command, file, positional, from } = parseArgs(args);

  try {
    switch (command) {
      case 'run': {
        const workflow = loadWorkflow(file);
        // Map positional args to workflow params in declaration order
        const params: Record<string, string> = {};
        for (let i = 0; i < positional.length; i++) {
          const param = workflow.params[i];
          const value = positional[i];
          if (param && value) params[param.name] = value;
        }
        await runWorkflow(workflow, params, { from });
        return 0;
      }
      case 'validate': {
        const workflow = loadWorkflow(file);
        console.log(`Workflow "${workflow.name}" is valid.`);
        console.log(`  ${workflow.steps.length} steps`);
        for (const step of workflow.steps) {
          console.log(
            `  - ${step.id} [${step.mode}] (session: ${step.session})`,
          );
        }
        return 0;
      }
      default:
        console.error(`Unknown command: ${command}`);
        console.log(usage());
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`baton: ${message}`);
    return 1;
  }
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
