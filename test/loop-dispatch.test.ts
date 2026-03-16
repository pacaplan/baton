import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowResult, runWorkflow } from '../src/runner.ts';
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

describe('dispatcher: loop steps', () => {
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
      'baton-loop-disp-' +
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

  it('executes counted loop with break_if and continues workflow', async () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: 'loop1',
          session: 'new',
          loop: { max: 3 },
          steps: [
            {
              id: 'body',
              command: 'echo iteration',
              session: 'new',
              break_if: 'success',
            },
          ],
        },
        {
          id: 'after-loop',
          mode: 'shell',
          command: 'echo after',
          session: 'new',
        },
      ],
    });

    const result = await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(result).toBe(WorkflowResult.Success);
    // 1 call for loop body (breaks on first iteration) + 1 for after-loop
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('counted loop exhaustion fails the workflow', async () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: 'loop1',
          session: 'new',
          loop: { max: 2 },
          steps: [
            {
              id: 'body',
              command: 'echo iteration',
              session: 'new',
            },
          ],
        },
        {
          id: 'after-loop',
          mode: 'shell',
          command: 'echo never',
          session: 'new',
        },
      ],
    });

    const result = await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(result).toBe(WorkflowResult.Failed);
    // 2 iterations of loop body, no after-loop
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });
});

describe('dispatcher: bare groups', () => {
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
      'baton-group-disp-' +
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

  it('executes bare group children sequentially', async () => {
    const wf = makeWorkflow({
      steps: [
        {
          id: 'group1',
          session: 'new',
          steps: [
            { id: 'child1', command: 'echo first', session: 'new' },
            { id: 'child2', command: 'echo second', session: 'new' },
          ],
        },
      ],
    });

    const result = await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(result).toBe(WorkflowResult.Success);
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('bare group fails workflow when child fails', async () => {
    let callCount = 0;
    spawnSpy.mockImplementation(() => {
      callCount++;
      return makeMockProc(callCount === 2 ? 1 : 0) as never;
    });

    const wf = makeWorkflow({
      steps: [
        {
          id: 'group1',
          session: 'new',
          steps: [
            { id: 'child1', command: 'echo first', session: 'new' },
            { id: 'child2', command: 'exit 1', session: 'new' },
            { id: 'child3', command: 'echo never', session: 'new' },
          ],
        },
      ],
    });

    const result = await runWorkflow(wf, {}, {
      workflowFile: 'test.yaml',
      stateDir: testStateDir,
    });

    expect(result).toBe(WorkflowResult.Failed);
    // Only 2 children run (child3 skipped because child2 failed)
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });
});
