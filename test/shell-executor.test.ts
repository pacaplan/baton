import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { executeShellStep } from '../src/executors/shell.ts';
import { createRootContext } from '../src/context.ts';
import type { ExecutionContext } from '../src/context.ts';
import type { Step } from '../src/schema.ts';

function makeCtx(
  params: Record<string, string> = {},
  captured: Record<string, string> = {},
): ExecutionContext {
  const ctx = createRootContext({
    params,
    workflowFile: 'test.yaml',
    engine: null,
  });
  Object.assign(ctx.capturedVariables, captured);
  return ctx;
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'test-shell',
    mode: 'shell',
    command: 'echo hello',
    session: 'new',
    ...overrides,
  };
}

function makeMockProc(exitCode = 0, stdout: string = '') {
  const stdoutStream = stdout
    ? new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      })
    : null;

  return {
    pid: 12345,
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
    stdin: null,
    stdout: stdoutStream,
    stderr: null,
  };
}

describe('executeShellStep', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let stdoutWriteSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    stdoutWriteSpy = spyOn(process.stdout, 'write').mockImplementation(
      () => true,
    );
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  it('runs a shell command and returns success', async () => {
    const step = makeStep({ command: 'echo hello' });
    const ctx = makeCtx();

    const outcome = await executeShellStep(step, ctx);

    expect(outcome).toBe('success');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[0]).toBe('sh');
    expect(callArgs[1]).toBe('-c');
    expect(callArgs[2]).toBe('echo hello');
  });

  it('returns failed for non-zero exit code', async () => {
    spawnSpy.mockImplementation(() => makeMockProc(1) as never);
    const step = makeStep({ command: 'exit 1' });
    const ctx = makeCtx();

    const outcome = await executeShellStep(step, ctx);

    expect(outcome).toBe('failed');
  });

  it('interpolates params in command', async () => {
    const step = makeStep({ command: 'deploy {{target}}' });
    const ctx = makeCtx({ target: 'prod' });

    await executeShellStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[2]).toBe('deploy prod');
  });

  it('interpolates captured variables in command', async () => {
    const step = makeStep({ command: 'echo {{output}}' });
    const ctx = makeCtx({}, { output: 'captured-value' });

    await executeShellStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[2]).toBe('echo captured-value');
  });

  it('uses stdout inherit when no capture', async () => {
    const step = makeStep({ command: 'echo hello' });
    const ctx = makeCtx();

    await executeShellStep(step, ctx);

    const spawnOpts = spawnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(spawnOpts.stdout).toBe('inherit');
  });

  it('captures stdout when capture field is set', async () => {
    spawnSpy.mockImplementation(
      () => makeMockProc(0, 'captured output\n') as never,
    );

    const step = makeStep({
      command: 'echo captured output',
      capture: 'my_var',
    });
    const ctx = makeCtx();

    await executeShellStep(step, ctx);

    expect(ctx.capturedVariables['my_var']).toBe('captured output');
  });

  it('uses pipe for stdout when capture is set', async () => {
    spawnSpy.mockImplementation(
      () => makeMockProc(0, 'output') as never,
    );

    const step = makeStep({
      command: 'echo output',
      capture: 'var',
    });
    const ctx = makeCtx();

    await executeShellStep(step, ctx);

    const spawnOpts = spawnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(spawnOpts.stdout).toBe('pipe');
  });

  it('tees output to terminal during capture', async () => {
    spawnSpy.mockImplementation(
      () => makeMockProc(0, 'tee output') as never,
    );

    const step = makeStep({
      command: 'echo tee output',
      capture: 'var',
    });
    const ctx = makeCtx();

    await executeShellStep(step, ctx);

    // process.stdout.write should have been called with the output
    expect(stdoutWriteSpy).toHaveBeenCalled();
  });

  it('returns failed without command', async () => {
    const step = makeStep({ command: undefined });
    const ctx = makeCtx();

    const outcome = await executeShellStep(step, ctx);

    expect(outcome).toBe('failed');
  });
});
