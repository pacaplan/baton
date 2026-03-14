import type { ExecutionContext } from '../context.ts';
import type { Step } from '../schema.ts';
import { interpolate } from '../shared/interpolation.ts';

type StepOutcome = 'success' | 'failed';

/**
 * Execute a shell step. When `capture` is set, stdout is piped
 * and teed to the terminal + stored in capturedVariables.
 * When `capture` is absent, stdout is inherited directly.
 */
export async function executeShellStep(
  step: Step,
  context: ExecutionContext,
): Promise<StepOutcome> {
  if (!step.command) return 'failed';

  const command = interpolate(step.command, context);
  console.log(`  command: ${command}`);

  const useCapture = !!step.capture;

  const proc = Bun.spawn(['sh', '-c', command], {
    stdin: 'inherit',
    stdout: useCapture ? 'pipe' : 'inherit',
    stderr: 'inherit',
  });

  if (useCapture && proc.stdout) {
    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();

    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
      } else {
        chunks.push(result.value);
        process.stdout.write(result.value);
      }
    }

    const combined = concatUint8Arrays(chunks);
    const text = new TextDecoder().decode(combined).trim();
    if (step.capture) {
      context.capturedVariables[step.capture] = text;
    }
  }

  const exitCode = await proc.exited;
  return exitCode === 0 ? 'success' : 'failed';
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const arr of arrays) {
    totalLen += arr.length;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
