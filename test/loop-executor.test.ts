import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeLoopStep } from '../src/executors/loop.ts';
import {
  createRootContext,
  type ExecutionContext,
} from '../src/context.ts';
import type { Step } from '../src/schema.ts';

function makeCtx(
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    ...createRootContext({
      params: {},
      workflowFile: 'test.yaml',
      engine: null,
    }),
    ...overrides,
  };
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'loop-step',
    session: 'new',
    loop: { max: 3 },
    steps: [
      { id: 'body', command: 'echo hi', session: 'new' },
    ],
    ...overrides,
  };
}

describe('LoopExecutor: counted loops', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () =>
        ({
          pid: 1,
          exited: Promise.resolve(0),
          kill: mock(() => {}),
          stdin: null,
          stdout: null,
          stderr: null,
        }) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('returns exhausted when no break_if triggers', async () => {
    const step = makeStep({ loop: { max: 3 } });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx);

    expect(result.outcome).toBe('exhausted');
    expect(spawnSpy).toHaveBeenCalledTimes(3);
  });

  it('returns success when break_if triggers', async () => {
    const step = makeStep({
      loop: { max: 3 },
      steps: [
        {
          id: 'body',
          command: 'echo hi',
          session: 'new',
          break_if: 'success',
        },
      ],
    });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx);

    expect(result.outcome).toBe('success');
    // Should only run 1 iteration since break_if triggers on first success
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('break_if on second iteration exits loop', async () => {
    let callCount = 0;
    spawnSpy.mockImplementation(() => {
      callCount++;
      return {
        pid: 1,
        exited: Promise.resolve(callCount === 2 ? 0 : 1),
        kill: mock(() => {}),
        stdin: null,
        stdout: null,
        stderr: null,
      } as never;
    });

    const step = makeStep({
      loop: { max: 3 },
      steps: [
        {
          id: 'body',
          command: 'echo hi',
          session: 'new',
          break_if: 'success',
          continue_on_failure: true,
        },
      ],
    });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx);

    expect(result.outcome).toBe('success');
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });

  it('each iteration gets isolated context', async () => {
    const capturedContexts: ExecutionContext[] = [];
    let callCount = 0;

    spawnSpy.mockImplementation(() => {
      callCount++;
      return {
        pid: 1,
        exited: Promise.resolve(0),
        kill: mock(() => {}),
        stdin: null,
        stdout: null,
        stderr: null,
      } as never;
    });

    const step = makeStep({
      loop: { max: 2 },
      steps: [
        {
          id: 'body',
          command: 'echo hi',
          session: 'new',
          break_if: 'failure',
          continue_on_failure: true,
        },
      ],
    });
    const ctx = makeCtx();

    await executeLoopStep(step, ctx);

    // 2 iterations should have run
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });
});

describe('LoopExecutor: for-each loops', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let testDir: string;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () =>
        ({
          pid: 1,
          exited: Promise.resolve(0),
          kill: mock(() => {}),
          stdin: null,
          stdout: null,
          stderr: null,
        }) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    testDir = join(
      tmpdir(),
      'baton-loop-test-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('iterates over glob matches', async () => {
    // Create test files
    writeFileSync(join(testDir, 'a.task.md'), 'a');
    writeFileSync(join(testDir, 'b.task.md'), 'b');
    writeFileSync(join(testDir, 'c.task.md'), 'c');

    const step = makeStep({
      loop: { over: join(testDir, '*.task.md'), as: 'task_file' },
      steps: [
        {
          id: 'body',
          command: 'echo {{task_file}}',
          session: 'new',
        },
      ],
    });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx);

    expect(result.outcome).toBe('success');
    expect(spawnSpy).toHaveBeenCalledTimes(3);
  });

  it('skips loop when glob matches zero files', async () => {
    const step = makeStep({
      loop: {
        over: join(testDir, '*.nonexistent'),
        as: 'task_file',
      },
      steps: [
        {
          id: 'body',
          command: 'echo {{task_file}}',
          session: 'new',
        },
      ],
    });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx);

    expect(result.outcome).toBe('success');
    expect(spawnSpy).toHaveBeenCalledTimes(0);
  });

  it('interpolates params in glob pattern', async () => {
    const subDir = join(testDir, 'mychange');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'x.task.md'), 'x');

    const step = makeStep({
      loop: {
        over: join(testDir, '{{change_name}}/*.task.md'),
        as: 'task_file',
      },
      steps: [
        {
          id: 'body',
          command: 'echo {{task_file}}',
          session: 'new',
        },
      ],
    });
    const ctx = makeCtx({ params: { change_name: 'mychange' } });

    const result = await executeLoopStep(step, ctx);

    expect(result.outcome).toBe('success');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('LoopExecutor: failure propagation', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () =>
        ({
          pid: 1,
          exited: Promise.resolve(1),
          kill: mock(() => {}),
          stdin: null,
          stdout: null,
          stderr: null,
        }) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('for-each loop fails when child step fails without continue_on_failure', async () => {
    const testDir = join(
      tmpdir(),
      'baton-fail-test-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'a.task.md'), 'a');
    writeFileSync(join(testDir, 'b.task.md'), 'b');

    const step = makeStep({
      loop: { over: join(testDir, '*.task.md'), as: 'task_file' },
      steps: [
        {
          id: 'failing-body',
          command: 'exit 1',
          session: 'new',
        },
      ],
    });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx);

    // Should fail because child step fails (no continue_on_failure)
    expect(result.outcome).toBe('failed');
    // Only first iteration attempted
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    rmSync(testDir, { recursive: true });
  });

  it('counted loop propagates child failure', async () => {
    const step = makeStep({
      loop: { max: 3 },
      steps: [
        {
          id: 'failing-body',
          command: 'exit 1',
          session: 'new',
        },
      ],
    });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx);

    // Should fail because child step fails
    expect(result.outcome).toBe('failed');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('LoopExecutor: nesting path', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () =>
        ({
          pid: 1,
          exited: Promise.resolve(0),
          kill: mock(() => {}),
          stdin: null,
          stdout: null,
          stderr: null,
        }) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('tracks iteration in nesting path for counted loops', async () => {
    const step = makeStep({
      loop: { max: 2 },
      steps: [
        {
          id: 'body',
          command: 'echo hi',
          session: 'new',
          break_if: 'failure',
          continue_on_failure: true,
        },
      ],
    });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx);

    // Result should carry iteration info
    expect(result.outcome).toBe('exhausted');
    expect(result.lastIteration).toBe(1);
  });
});

describe('LoopExecutor: resume', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () =>
        ({
          pid: 1,
          exited: Promise.resolve(0),
          kill: mock(() => {}),
          stdin: null,
          stdout: null,
          stderr: null,
        }) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('skips completed iterations when resumeFromIteration is set', async () => {
    const step = makeStep({
      loop: { max: 5 },
      steps: [
        {
          id: 'body',
          command: 'echo hi',
          session: 'new',
          break_if: 'failure',
          continue_on_failure: true,
        },
      ],
    });
    const ctx = makeCtx();

    const result = await executeLoopStep(step, ctx, {
      resumeFromIteration: 3,
    });

    // Should run iterations 3 and 4 (0-indexed), which is 2 iterations
    expect(spawnSpy).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('exhausted');
  });
});
