import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from '../src/runner.ts';
import type { Engine } from '../src/engine.ts';
import type { Workflow } from '../src/schema.ts';

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
  let testStateDir: string;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => makeMockProc(0) as never);
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    testStateDir = join(tmpdir(), 'baton-runner-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    mkdirSync(testStateDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true });
    }
  });

  it('runs a single shell step successfully', async () => {
    const wf = makeWorkflow();
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir });

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
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir });

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
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir });

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
    await runWorkflow(wf, {}, { from: 'start-here', workflowFile: 'test.yaml', stateDir: testStateDir });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[2]).toBe('echo start');
  });

  it('throws for unknown --from step', async () => {
    const wf = makeWorkflow();
    await expect(
      runWorkflow(wf, {}, { from: 'nonexistent', workflowFile: 'test.yaml', stateDir: testStateDir }),
    ).rejects.toThrow('Step "nonexistent" not found');
  });

  it('interpolates params in shell commands', async () => {
    const wf = makeWorkflow({
      params: [{ name: 'target', required: true }],
      steps: [
        { id: 'deploy', mode: 'shell', command: 'deploy {{target}}', session: 'new' },
      ],
    });
    await runWorkflow(wf, { target: 'prod' }, { workflowFile: 'test.yaml', stateDir: testStateDir });

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
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir });

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
    await expect(
      runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir }),
    ).rejects.toThrow('Missing required parameter: secret');
  });

  it('runs headless agent step with -p flag', async () => {
    const wf = makeWorkflow({
      steps: [
        { id: 'agent-step', mode: 'headless', prompt: 'Do the thing', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir });

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain('claude');
    expect(callArgs).toContain('-p');
    expect(callArgs).toContain('Do the thing');
  });

  it('deletes state file after successful completion', async () => {
    const wf = makeWorkflow();
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir });

    const stateFile = join(testStateDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(false);
  });

  it('writes state file after step completes', async () => {
    spawnSpy.mockImplementation(() => makeMockProc(1) as never);

    const wf = makeWorkflow({
      steps: [
        { id: 'failing', mode: 'shell', command: 'exit 1', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir });

    const stateFile = join(testStateDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(state.currentStep).toBe('failing');
    expect(state.workflowName).toBe('test-wf');
  });
});

describe('runWorkflow with engine', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let testStateDir: string;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => makeMockProc(0) as never);
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    testStateDir = join(tmpdir(), 'baton-runner-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    mkdirSync(testStateDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true });
    }
  });

  it('calls validateWorkflow when engine implements it', async () => {
    const validateWorkflow = mock(() => {});
    const engine: Engine = { validateWorkflow };

    const wf = makeWorkflow();
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    expect(validateWorkflow).toHaveBeenCalledTimes(1);
    expect(validateWorkflow).toHaveBeenCalledWith(wf);
  });

  it('aborts when validateWorkflow throws', async () => {
    const engine: Engine = {
      validateWorkflow: () => {
        throw new Error('Workflow incompatible with engine');
      },
    };

    const wf = makeWorkflow();
    await expect(
      runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine }),
    ).rejects.toThrow('Workflow incompatible with engine');

    // No steps should have been executed
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('skips validateWorkflow when engine does not implement it', async () => {
    const engine: Engine = {};

    const wf = makeWorkflow();
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    // Should proceed to execute steps
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('calls enrichPrompt and prepends result to agent step prompt', async () => {
    const engine: Engine = {
      enrichPrompt: (_stepId: string, _params: Record<string, string>) => {
        return 'Engine context: do this first.';
      },
    };

    const wf = makeWorkflow({
      steps: [
        { id: 'design', mode: 'headless', prompt: 'Design the feature', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    // The last arg should be the combined prompt
    const promptArg = callArgs[callArgs.length - 1];
    expect(promptArg).toContain('Engine context: do this first.');
    expect(promptArg).toContain('Design the feature');
    // Engine context should come first
    expect(promptArg!.indexOf('Engine context')).toBeLessThan(promptArg!.indexOf('Design the feature'));
  });

  it('does not modify prompt when enrichPrompt returns undefined', async () => {
    const engine: Engine = {
      enrichPrompt: () => undefined,
    };

    const wf = makeWorkflow({
      steps: [
        { id: 'other', mode: 'headless', prompt: 'Do stuff', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    const promptArg = callArgs[callArgs.length - 1];
    expect(promptArg).toBe('Do stuff');
  });

  it('does not call enrichPrompt when engine does not implement it', async () => {
    const engine: Engine = {};

    const wf = makeWorkflow({
      steps: [
        { id: 'step1', mode: 'headless', prompt: 'Original prompt', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    const promptArg = callArgs[callArgs.length - 1];
    expect(promptArg).toBe('Original prompt');
  });

  it('calls validateStep after successful agent step', async () => {
    const validateStep = mock(() => true);
    const engine: Engine = { validateStep };

    const wf = makeWorkflow({
      steps: [
        { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
      ],
    });
    await runWorkflow(wf, { foo: 'bar' }, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    expect(validateStep).toHaveBeenCalledTimes(1);
    expect(validateStep).toHaveBeenCalledWith('design', { foo: 'bar' });
  });

  it('skips validateStep when engine does not implement it', async () => {
    const engine: Engine = {};

    const wf = makeWorkflow({
      steps: [
        { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    // Step should complete, no errors
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not call enrichPrompt for shell steps', async () => {
    const enrichPrompt = mock(() => 'enriched');
    const engine: Engine = { enrichPrompt };

    const wf = makeWorkflow({
      steps: [
        { id: 'build', mode: 'shell', command: 'echo hi', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    // enrichPrompt should not be called for shell steps
    expect(enrichPrompt).not.toHaveBeenCalled();
  });

  it('does not call validateStep for shell steps', async () => {
    const validateStep = mock(() => true);
    const engine: Engine = { validateStep };

    const wf = makeWorkflow({
      steps: [
        { id: 'build', mode: 'shell', command: 'echo hi', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    expect(validateStep).not.toHaveBeenCalled();
  });

  it('uses engine getStateDir for state file location', async () => {
    const customDir = join(tmpdir(), 'baton-custom-state-' + Date.now());
    mkdirSync(customDir, { recursive: true });

    const engine: Engine = {
      getStateDir: () => customDir,
    };

    spawnSpy.mockImplementation(() => makeMockProc(1) as never);

    const wf = makeWorkflow({
      steps: [
        { id: 'failing', mode: 'shell', command: 'exit 1', session: 'new' },
      ],
    });
    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    // State should be in the engine's custom dir
    const stateFile = join(customDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(true);

    // Clean up
    rmSync(customDir, { recursive: true });
  });

  it('passes step ID to enrichPrompt', async () => {
    const enrichPrompt = mock(() => undefined);
    const engine: Engine = { enrichPrompt };

    const wf = makeWorkflow({
      steps: [
        { id: 'my-step', mode: 'headless', prompt: 'Do it', session: 'new' },
      ],
    });
    await runWorkflow(wf, { x: 'y' }, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    expect(enrichPrompt).toHaveBeenCalledWith('my-step', { x: 'y' });
  });

  it('prompts user when validateStep fails and exits on q', async () => {
    const engine: Engine = {
      validateStep: () => false,
    };

    const wf = makeWorkflow({
      steps: [
        { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
        { id: 'next', mode: 'shell', command: 'echo next', session: 'new' },
      ],
    });

    const promptUser = mock(async () => 'q');

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
      engine,
      promptUser,
    });

    // promptUser should have been called
    expect(promptUser).toHaveBeenCalledTimes(1);
    // Only one step should have been spawned (the agent step, not the next one)
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('resumes session when validateStep fails and user chooses r', async () => {
    let validateCallCount = 0;
    const engine: Engine = {
      validateStep: () => {
        validateCallCount++;
        // Fails first time, passes on re-validation
        return validateCallCount > 1;
      },
    };

    const wf = makeWorkflow({
      steps: [
        { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
      ],
    });

    const promptUser = mock(async () => 'r');

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
      engine,
      promptUser,
      sessionIds: { design: 'sess-123' },
    });

    expect(promptUser).toHaveBeenCalledTimes(1);
    // Original step spawn + resume session spawn = 2
    expect(spawnSpy).toHaveBeenCalledTimes(2);
    // The resume call should use --resume with the session ID
    const resumeArgs = spawnSpy.mock.calls[1]?.[0] as string[];
    expect(resumeArgs).toContain('--resume');
    expect(resumeArgs).toContain('sess-123');
  });

  it('stops when validateStep fails and user chooses r but no session ID exists', async () => {
    const engine: Engine = {
      validateStep: () => false,
    };

    const wf = makeWorkflow({
      steps: [
        { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
        { id: 'next', mode: 'shell', command: 'echo next', session: 'new' },
      ],
    });

    const promptUser = mock(async () => 'r');

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
      engine,
      promptUser,
    });

    // Should have prompted and then stopped (no session ID to resume)
    expect(promptUser).toHaveBeenCalledTimes(1);
    // Only the agent step spawn, no resume spawn, no next step
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('proceeds to next step when validateStep returns true', async () => {
    const engine: Engine = {
      validateStep: () => true,
    };

    const wf = makeWorkflow({
      steps: [
        { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
        { id: 'build', mode: 'shell', command: 'echo build', session: 'new' },
      ],
    });

    await runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir, engine });

    // Both steps should have run
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });
});
