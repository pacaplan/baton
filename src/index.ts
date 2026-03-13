import { loadWorkflow } from './loader.ts';
import { runWorkflow } from './runner.ts';

function usage(): string {
  return [
    'Usage: baton <command> [options]',
    '',
    'Commands:',
    '  run <workflow.yaml> [--param key=value ...] [--from step-id]',
    '  validate <workflow.yaml>',
    '',
    'Examples:',
    '  baton run workflows/flokay.yaml --param change_name=add-auth --param description="Add auth"',
    '  baton run workflows/flokay.yaml --from implement',
    '  baton validate workflows/flokay.yaml',
  ].join('\n');
}

function parseArgs(args: string[]): {
  command: string;
  file: string;
  params: Record<string, string>;
  from?: string;
} {
  const [command, file, ...rest] = args;

  if (!(command && file)) {
    console.log(usage());
    process.exit(1);
  }

  const params: Record<string, string> = {};
  let from: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const nextArg = rest[i + 1];
    if (arg === '--param' && nextArg) {
      const [key, ...valueParts] = nextArg.split('=');
      if (key) {
        params[key] = valueParts.join('=');
      }
      i++;
    } else if (arg === '--from' && nextArg) {
      from = nextArg;
      i++;
    }
  }

  return { command, file, params, from };
}

export async function main(args: string[]): Promise<number> {
  const { command, file, params, from } = parseArgs(args);

  try {
    switch (command) {
      case 'run': {
        const workflow = loadWorkflow(file);
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
