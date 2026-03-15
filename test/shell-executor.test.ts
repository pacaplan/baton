import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeShellStep } from '../src/executors/shell.ts';
import { createRootContext } from '../src/context.ts';
import type { ExecutionContext } from '../src/context.ts';
import type { Step } from '../src/schema.ts';
import { AuditLogger } from '../src/audit.ts';

function makeCtx(
  params: Record<string, string> = {},
  captured: Record<string, string> = {},
  auditLogger: AuditLogger | null = null,
): ExecutionContext {
  const ctx = createRootContext({
    params,
    workflowFile: 'test.yaml',
    engine: null,
    auditLogger,
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

function makeMockProc(exitCode = 0, stdout: string = '', stderr: string = '') {
  const stdoutStream = stdout
    ? new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      })
    : null;

  const stderrStream = new ReadableStream({
    start(controller) {
      if (stderr) {
        controller.enqueue(new TextEncoder().encode(stderr));
      }
      controller.close();
    },
  });

  return {
    pid: 12345,
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
    stdin: null,
    stdout: stdoutStream,
    stderr: stderrStream,
  };
}

describe('executeShellStep', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let stdoutWriteSpy: ReturnType<typeof spyOn>;
  let stderrWriteSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    stdoutWriteSpy = spyOn(process.stdout, 'write').mockImplementation(
      () => true,
    );
    stderrWriteSpy = spyOn(process.stderr, 'write').mockImplementation(
      () => true,
    );
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
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

  it('uses pipe for stderr in all cases', async () => {
    const step = makeStep({ command: 'echo hello' });
    const ctx = makeCtx();

    await executeShellStep(step, ctx);

    const spawnOpts = spawnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(spawnOpts.stderr).toBe('pipe');
  });

  it('tees stderr to terminal in real-time', async () => {
    spawnSpy.mockImplementation(
      () => makeMockProc(0, '', 'error output') as never,
    );

    const step = makeStep({ command: 'echo hello' });
    const ctx = makeCtx();

    await executeShellStep(step, ctx);

    expect(stderrWriteSpy).toHaveBeenCalled();
  });

  it('captures stderr regardless of capture field', async () => {
    spawnSpy.mockImplementation(
      () => makeMockProc(0, '', 'some error') as never,
    );

    const step = makeStep({ command: 'echo hello' });
    const ctx = makeCtx();

    await executeShellStep(step, ctx);

    // stderr was piped (not inherited)
    const spawnOpts = spawnSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(spawnOpts.stderr).toBe('pipe');
  });
});

describe('executeShellStep audit events', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let testDir: string;

  beforeEach(() => {
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(process.stdout, 'write').mockImplementation(() => true);
    spyOn(process.stderr, 'write').mockImplementation(() => true);
    testDir = join(
      tmpdir(),
      'baton-shell-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('emits step_start with command and context snapshot', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );

    const logPath = join(testDir, 'audit.log');
    const logger = new AuditLogger(logPath);
    const ctx = makeCtx({ env: 'staging' }, { build_output: '/tmp/build' }, logger);
    const step = makeStep({ command: 'npm test' });

    await executeShellStep(step, ctx);
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    const startLine = lines.find(l => l.includes('step_start'));
    expect(startLine).toBeTruthy();
    const json = JSON.parse(startLine!.substring(startLine!.indexOf('{')));
    expect(json.command).toBe('npm test');
    expect(json.context.params.env).toBe('staging');
    expect(json.context.capturedVariables.build_output).toBe('/tmp/build');
  });

  it('emits step_end with exit code, stderr, outcome, and duration_ms', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0, '', 'warn: something') as never,
    );

    const logPath = join(testDir, 'audit.log');
    const logger = new AuditLogger(logPath);
    const ctx = makeCtx({}, {}, logger);
    const step = makeStep({ command: 'echo hello' });

    await executeShellStep(step, ctx);
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    const endLine = lines.find(l => l.includes('step_end'));
    expect(endLine).toBeTruthy();
    const json = JSON.parse(endLine!.substring(endLine!.indexOf('{')));
    expect(json.exit_code).toBe(0);
    expect(json.stderr).toBe('warn: something');
    expect(json.outcome).toBe('success');
    expect(typeof json.duration_ms).toBe('number');
  });

  it('includes captured stdout in step_end when capture is set', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0, 'captured-output\n', '') as never,
    );

    const logPath = join(testDir, 'audit.log');
    const logger = new AuditLogger(logPath);
    const ctx = makeCtx({}, {}, logger);
    const step = makeStep({ command: 'echo captured-output', capture: 'test_output' });

    await executeShellStep(step, ctx);
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    const endLine = lines.find(l => l.includes('step_end'));
    const json = JSON.parse(endLine!.substring(endLine!.indexOf('{')));
    expect(json.stdout).toBe('captured-output');
    expect(json.exit_code).toBe(0);
  });

  it('omits stdout from step_end when capture is not set', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );

    const logPath = join(testDir, 'audit.log');
    const logger = new AuditLogger(logPath);
    const ctx = makeCtx({}, {}, logger);
    const step = makeStep({ command: 'echo hello' });

    await executeShellStep(step, ctx);
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    const endLine = lines.find(l => l.includes('step_end'));
    const json = JSON.parse(endLine!.substring(endLine!.indexOf('{')));
    expect(json.stdout).toBeUndefined();
  });

  it('includes empty stderr in step_end when no stderr output', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );

    const logPath = join(testDir, 'audit.log');
    const logger = new AuditLogger(logPath);
    const ctx = makeCtx({}, {}, logger);
    const step = makeStep({ command: 'echo hello' });

    await executeShellStep(step, ctx);
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    const endLine = lines.find(l => l.includes('step_end'));
    const json = JSON.parse(endLine!.substring(endLine!.indexOf('{')));
    expect(json.stderr).toBe('');
  });

  it('reports outcome failed when exit code is non-zero', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(1, '', 'error msg') as never,
    );

    const logPath = join(testDir, 'audit.log');
    const logger = new AuditLogger(logPath);
    const ctx = makeCtx({}, {}, logger);
    const step = makeStep({ command: 'exit 1' });

    await executeShellStep(step, ctx);
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const endLine = content.trim().split('\n').find(l => l.includes('step_end'));
    const json = JSON.parse(endLine!.substring(endLine!.indexOf('{')));
    expect(json.outcome).toBe('failed');
    expect(json.exit_code).toBe(1);
  });

  it('does not emit audit events when auditLogger is null', async () => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );

    const ctx = makeCtx(); // no auditLogger
    const step = makeStep({ command: 'echo hello' });

    // Should not throw
    const outcome = await executeShellStep(step, ctx);
    expect(outcome).toBe('success');
  });
});
