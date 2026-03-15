import { buildPrefix } from '../audit.ts';
import type { ExecutionContext } from '../context.ts';
import type { Step } from '../schema.ts';
import { interpolate } from '../shared/interpolation.ts';

type StepOutcome = 'success' | 'failed';

/**
 * Read a readable stream, tee each chunk to a writer, and collect all chunks.
 */
async function readAndTee(
  stream: ReadableStream<Uint8Array>,
  writer: { write(data: Uint8Array): void },
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let done = false;
  while (!done) {
    const result = await reader.read();
    if (result.done) {
      done = true;
    } else {
      chunks.push(result.value);
      writer.write(result.value);
    }
  }
  return chunks;
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

function decodeChunks(chunks: Uint8Array[]): string {
  return new TextDecoder().decode(concatUint8Arrays(chunks)).trim();
}

/** Emit step_start and step_end when interpolation fails before spawn. */
function emitInterpolationFailure(
  step: Step,
  context: ExecutionContext,
  errorMsg: string,
): void {
  const prefix = buildPrefix(context.nestingPath, step.id);
  const snapshot = {
    params: { ...context.params },
    capturedVariables: { ...context.capturedVariables },
  };
  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: { command: step.command, context: snapshot },
  });
  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_end',
    data: { outcome: 'failed', error: errorMsg, duration_ms: 0 },
  });
}

/** Emit audit events and run the spawned process. */
async function runSpawnedProcess(
  step: Step,
  context: ExecutionContext,
  command: string,
): Promise<StepOutcome> {
  const startTime = Date.now();
  const prefix = buildPrefix(context.nestingPath, step.id);

  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: {
      command,
      context: {
        params: { ...context.params },
        capturedVariables: { ...context.capturedVariables },
      },
    },
  });

  const useCapture = !!step.capture;
  const proc = Bun.spawn(['sh', '-c', command], {
    stdin: 'inherit',
    stdout: useCapture ? 'pipe' : 'inherit',
    stderr: 'pipe',
  });

  // Read stdout and stderr concurrently to avoid deadlock
  const stderrPromise = proc.stderr
    ? readAndTee(proc.stderr, process.stderr)
    : Promise.resolve([] as Uint8Array[]);
  const stdoutPromise =
    useCapture && proc.stdout
      ? readAndTee(proc.stdout, process.stdout)
      : Promise.resolve(null);

  const [stderrChunks, stdoutChunks] = await Promise.all([
    stderrPromise,
    stdoutPromise,
  ]);

  let capturedStdout: string | undefined;
  if (stdoutChunks && step.capture) {
    capturedStdout = decodeChunks(stdoutChunks);
    context.capturedVariables[step.capture] = capturedStdout;
  }

  const exitCode = await proc.exited;
  const outcome: StepOutcome = exitCode === 0 ? 'success' : 'failed';

  const endData: Record<string, unknown> = {
    exit_code: exitCode,
    stderr: decodeChunks(stderrChunks),
    outcome,
    duration_ms: Date.now() - startTime,
  };
  if (capturedStdout !== undefined) {
    endData.stdout = capturedStdout;
  }

  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_end',
    data: endData,
  });

  return outcome;
}

/**
 * Execute a shell step. When `capture` is set, stdout is piped
 * and teed to the terminal + stored in capturedVariables.
 * When `capture` is absent, stdout is inherited directly.
 * Stderr is always piped, teed to terminal, and stored for audit log.
 */
export async function executeShellStep(
  step: Step,
  context: ExecutionContext,
): Promise<StepOutcome> {
  if (!step.command) return 'failed';

  let command: string;
  try {
    command = interpolate(step.command, context);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    emitInterpolationFailure(step, context, errorMsg);
    throw err;
  }

  console.log(`  command: ${command}`);
  return runSpawnedProcess(step, context, command);
}
