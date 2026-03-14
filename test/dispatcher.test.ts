import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from '../src/runner.ts';
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

describe('dispatcher: continue_on_failure', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let testStateDir: string;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    testStateDir = join(
      tmpdir(),
      'baton-disp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testStateDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true });
    }
  });

  it('continues after failed step when continue_on_failure is true', async () => {
    let callCount = 0;
    spawnSpy.mockImplementation(() => {
      callCount++;
      // First step fails, second succeeds
      return makeMockProc(callCount === 1 ? 1 : 0) as never;
    });

    const wf = makeWorkflow({
      steps: [
        {
          id: 'failing',
          mode: 'shell',
          command: 'exit 1',
          session: 'new',
          continue_on_failure: true,
        },
        {
          id: 'next',
          mode: 'shell',
          command: 'echo next',
          session: 'new',
        },
      ],
    });

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('stops after failed step without continue_on_failure', async () => {
    spawnSpy.mockImplementation(() => makeMockProc(1) as never);

    const wf = makeWorkflow({
      steps: [
        {
          id: 'failing',
          mode: 'shell',
          command: 'exit 1',
          session: 'new',
        },
        {
          id: 'never',
          mode: 'shell',
          command: 'echo never',
          session: 'new',
        },
      ],
    });

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('dispatcher: skip_if', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let testStateDir: string;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    testStateDir = join(
      tmpdir(),
      'baton-disp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testStateDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true });
    }
  });

  it('skips step when previous succeeded and skip_if=previous_success', async () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: 'success-step',
          mode: 'shell',
          command: 'echo ok',
          session: 'new',
        },
        {
          id: 'skipped',
          mode: 'shell',
          command: 'echo should-skip',
          session: 'new',
          skip_if: 'previous_success',
        },
        {
          id: 'final',
          mode: 'shell',
          command: 'echo final',
          session: 'new',
        },
      ],
    });

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    // step1 and step3 run, step2 is skipped
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('runs step when previous failed and skip_if=previous_success', async () => {
    let callCount = 0;
    spawnSpy.mockImplementation(() => {
      callCount++;
      return makeMockProc(callCount === 1 ? 1 : 0) as never;
    });

    const wf = makeWorkflow({
      steps: [
        {
          id: 'failing',
          mode: 'shell',
          command: 'exit 1',
          session: 'new',
          continue_on_failure: true,
        },
        {
          id: 'runs-on-failure',
          mode: 'shell',
          command: 'echo fix it',
          session: 'new',
          skip_if: 'previous_success',
        },
      ],
    });

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    // Both steps run
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });
});

describe('dispatcher: state file with nested format', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let testStateDir: string;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    testStateDir = join(
      tmpdir(),
      'baton-disp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testStateDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true });
    }
  });

  it('writes nested state format after step', async () => {
    spawnSpy.mockImplementation(() => makeMockProc(1) as never);

    const wf = makeWorkflow({
      steps: [
        { id: 'failing', mode: 'shell', command: 'exit 1', session: 'new' },
      ],
    });

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    const stateFile = join(testStateDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    // Should use nested format
    expect(typeof state.currentStep).toBe('object');
    expect(state.currentStep.stepId).toBe('failing');
  });

  it('includes captured variables in state', async () => {
    const stdout = 'captured-value\n';
    const stdoutStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    });

    spawnSpy.mockImplementation(() => ({
      pid: 12345,
      exited: Promise.resolve(1),
      kill: mock(() => {}),
      stdin: null,
      stdout: stdoutStream,
      stderr: null,
    }) as never);

    spyOn(process.stdout, 'write').mockImplementation(() => true);

    const wf = makeWorkflow({
      steps: [
        {
          id: 'capture-step',
          mode: 'shell',
          command: 'echo captured-value',
          capture: 'my_output',
          session: 'new',
          continue_on_failure: true,
        },
        {
          id: 'failing',
          mode: 'shell',
          command: 'exit 1',
          session: 'new',
        },
      ],
    });

    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    const stateFile = join(testStateDir, 'baton-state.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(state.currentStep.capturedVariables.my_output).toBe('captured-value');
  });

  it('deletes state file on successful completion', async () => {
    const wf = makeWorkflow();
    await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    const stateFile = join(testStateDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe('dispatcher: loop and sub-workflow stubs', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let testStateDir: string;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    testStateDir = join(
      tmpdir(),
      'baton-disp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testStateDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true });
    }
  });

  it('executes loop steps via loop executor', async () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: 'loop1',
          loop: { max: 3 },
          steps: [
            {
              id: 'body',
              mode: 'shell',
              command: 'echo hi',
              session: 'new',
              break_if: 'success' as const,
            },
          ],
          session: 'new',
        },
      ],
    });

    const result = await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(result).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('throws descriptive error for missing sub-workflow file', async () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: 'sub1',
          workflow: 'sub.yaml',
          session: 'new',
        },
      ],
    });

    await expect(
      runWorkflow(wf, {}, { workflowFile: 'test.yaml', stateDir: testStateDir }),
    ).rejects.toThrow(/sub\.yaml/);
  });
});
