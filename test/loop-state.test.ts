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

describe('loop state tracking', () => {
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
      'baton-loop-state-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2),
    );
    mkdirSync(testStateDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (existsSync(testStateDir)) {
      rmSync(testStateDir, { recursive: true });
    }
  });

  it('records loop iteration in state file via child nesting', async () => {
    // Counted loop with 3 iterations, no break_if => exhaustion failure.
    // The state should record the loop step with a child showing iteration.
    let callCount = 0;
    spawnSpy.mockImplementation(() => {
      callCount++;
      return makeMockProc(callCount <= 3 ? 0 : 0) as never;
    });

    const wf = makeWorkflow({
      steps: [
        {
          id: 'retry-loop',
          session: 'new',
          loop: { max: 3 },
          steps: [
            {
              id: 'body',
              command: 'echo hi',
              session: 'new',
            },
          ],
        },
      ],
    });

    const result = await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(result).toBe(false);

    const stateFile = join(testStateDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(state.currentStep.stepId).toBe('retry-loop');
    // Should have a child recording the last iteration
    expect(state.currentStep.child).not.toBeNull();
    expect(state.currentStep.child.stepId).toBe('retry-loop:iteration');
  });

  it('records loop step in state after exhaustion failure', async () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: 'retry-loop',
          session: 'new',
          loop: { max: 2 },
          steps: [
            {
              id: 'body',
              command: 'echo hi',
              session: 'new',
            },
          ],
        },
      ],
    });

    const result = await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(result).toBe(false);

    const stateFile = join(testStateDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(state.currentStep.stepId).toBe('retry-loop');
  });
});
