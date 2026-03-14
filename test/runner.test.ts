import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { runWorkflow } from '../src/runner.ts';
import type { Workflow } from '../src/schema.ts';

const STATE_FILE = '.baton-state.json';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: 'test-wf',
    agent: 'claude-code',
    params: [],
    steps: [
      { id: 'step1', mode: 'shell', command: 'echo hello', session: 'new' },
    ],
    ...overrides,
  };
}

function makeMockProc(exitCode = 0) {
  return {
    pid: 12345,
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
    stdin: null,
    stdout: null,
    stderr: null,
  };
}

describe('runWorkflow', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => makeMockProc(0) as never);
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    // Clean up state file if it exists
    if (existsSync(STATE_FILE)) {
      unlinkSync(STATE_FILE);
    }
  });

  it('runs a single shell step successfully', async () => {
    const wf = makeWorkflow();
    await runWorkflow(wf, {});

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[0]).toBe('sh');
    expect(callArgs[1]).toBe('-c');
    expect(callArgs[2]).toBe('echo hello');
  });

  it('runs multiple steps in order', async () => {
    const wf = makeWorkflow({
      steps: [
        { id: 'first', mode: 'shell', command: 'echo first', session: 'new' },
        { id: 'second', mode: 'shell', command: 'echo second', session: 'new' },
      ],
    });
    await runWorkflow(wf, {});

    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('stops on failed step', async () => {
    spawnSpy.mockImplementation(() => makeMockProc(1) as never);

    const wf = makeWorkflow({
      steps: [
        { id: 'failing', mode: 'shell', command: 'exit 1', session: 'new' },
        { id: 'never', mode: 'shell', command: 'echo never', session: 'new' },
      ],
    });
    await runWorkflow(wf, {});

    // Only the first step should have been attempted
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('starts from a specific step with --from', async () => {
    const wf = makeWorkflow({
      steps: [
        { id: 'skip-me', mode: 'shell', command: 'echo skip', session: 'new' },
        { id: 'start-here', mode: 'shell', command: 'echo start', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { from: 'start-here' });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[2]).toBe('echo start');
  });

  it('throws for unknown --from step', async () => {
    const wf = makeWorkflow();
    await expect(
      runWorkflow(wf, {}, { from: 'nonexistent' }),
    ).rejects.toThrow('Step "nonexistent" not found');
  });

  it('interpolates params in shell commands', async () => {
    const wf = makeWorkflow({
      params: [{ name: 'target', required: true }],
      steps: [
        { id: 'deploy', mode: 'shell', command: 'deploy {{target}}', session: 'new' },
      ],
    });
    await runWorkflow(wf, { target: 'prod' });

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[2]).toBe('deploy prod');
  });

  it('applies default values for missing params', async () => {
    const wf = makeWorkflow({
      params: [{ name: 'env', required: true, default: 'staging' }],
      steps: [
        { id: 's1', mode: 'shell', command: 'deploy {{env}}', session: 'new' },
      ],
    });
    await runWorkflow(wf, {});

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[2]).toBe('deploy staging');
  });

  it('throws for missing required param without default', async () => {
    const wf = makeWorkflow({
      params: [{ name: 'secret', required: true }],
      steps: [
        { id: 's1', mode: 'shell', command: 'echo {{secret}}', session: 'new' },
      ],
    });
    await expect(runWorkflow(wf, {})).rejects.toThrow(
      'Missing required parameter: secret',
    );
  });

  it('runs headless agent step with -p flag', async () => {
    const wf = makeWorkflow({
      steps: [
        { id: 'agent-step', mode: 'headless', prompt: 'Do the thing', session: 'new' },
      ],
    });
    await runWorkflow(wf, {});

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain('claude');
    expect(callArgs).toContain('-p');
    expect(callArgs).toContain('Do the thing');
  });

  it('saves state file during execution', async () => {
    const wf = makeWorkflow();
    await runWorkflow(wf, {});

    // State file should be cleaned up after successful run
    expect(existsSync(STATE_FILE)).toBe(false);
  });
});
