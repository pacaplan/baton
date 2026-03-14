import { Command } from 'commander';
import {
  registerRunCommand,
  registerValidateCommand,
} from './commands/index.ts';

const program = new Command();

program
  .name('baton')
  .description('CLI workflow orchestrator for AI agents')
  .version('0.1.0');

registerRunCommand(program);
registerValidateCommand(program);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`baton: ${message}`);
  process.exit(1);
}
