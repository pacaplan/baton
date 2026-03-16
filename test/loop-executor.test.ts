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
import type { AuditEvent } from '../src/audit.ts';
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

  it('fails when require_matches is set and glob matches zero files', async () => {
    spyOn(console, 'error').mockImplementation(() => {});
    const step = makeStep({
      loop: {
        over: join(testDir, '*.nonexistent'),
        as: 'task_file',
        require_matches: true,
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

    expect(result.outcome).toBe('failed');
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

function makeSpyLogger() {
  const events: AuditEvent[] = [];
  return {
    events,
    emit(event: AuditEvent) { events.push(event); },
    close() {},
  };
}

function makeMockProc(exitCode = 0) {
  const stderrStream = new ReadableStream({
    start(controller) { controller.close(); },
  });
  return {
    pid: 1,
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
    stdin: null,
    stdout: null,
    stderr: stderrStream,
  };
}

describe('LoopExecutor: audit events', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('emits step_start with loop type counted and max', async () => {
    const logger = makeSpyLogger();
    const step = makeStep({
      id: 'my-loop',
      loop: { max: 5 },
      steps: [{ id: 'body', command: 'echo hi', session: 'new', break_if: 'success' }],
    });
    const ctx = makeCtx({ auditLogger: logger });

    await executeLoopStep(step, ctx);

    const loopStart = logger.events.find(e => e.type === 'step_start' && e.data.loop_type);
    expect(loopStart).toBeTruthy();
    expect(loopStart!.data.loop_type).toBe('counted');
    expect(loopStart!.data.max).toBe(5);
    expect(loopStart!.data.context).toEqual({
      params: {},
      capturedVariables: {},
    });
  });

  it('emits step_start with loop type for-each, glob, and resolved matches', async () => {
    const testDir = join(
      tmpdir(),
      'baton-loop-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'a.md'), 'a');
    writeFileSync(join(testDir, 'b.md'), 'b');
    writeFileSync(join(testDir, 'c.md'), 'c');

    const logger = makeSpyLogger();
    const step = makeStep({
      id: 'my-loop',
      loop: { over: join(testDir, '*.md'), as: 'file' },
      steps: [{ id: 'body', command: 'echo {{file}}', session: 'new' }],
    });
    const ctx = makeCtx({ auditLogger: logger });

    await executeLoopStep(step, ctx);

    const loopStart = logger.events.find(e => e.type === 'step_start' && e.data.loop_type);
    expect(loopStart).toBeTruthy();
    expect(loopStart!.data.loop_type).toBe('for-each');
    expect(loopStart!.data.glob_pattern).toBe(join(testDir, '*.md'));
    expect((loopStart!.data.resolved_matches as string[]).length).toBe(3);

    rmSync(testDir, { recursive: true });
  });

  it('emits step_end with iterations_completed and break_triggered', async () => {
    let callCount = 0;
    spawnSpy.mockImplementation(() => {
      callCount++;
      return makeMockProc(callCount <= 2 ? 1 : 0) as never;
    });

    const logger = makeSpyLogger();
    const step = makeStep({
      id: 'my-loop',
      loop: { max: 5 },
      steps: [{
        id: 'body',
        command: 'echo hi',
        session: 'new',
        break_if: 'success',
        continue_on_failure: true,
      }],
    });
    const ctx = makeCtx({ auditLogger: logger });

    await executeLoopStep(step, ctx);

    const loopEnd = logger.events.find(e => e.type === 'step_end' && e.data.iterations_completed !== undefined);
    expect(loopEnd).toBeTruthy();
    expect(loopEnd!.data.iterations_completed).toBe(3);
    expect(loopEnd!.data.break_triggered).toBe(true);
    expect(loopEnd!.data.outcome).toBe('success');
    expect(typeof loopEnd!.data.duration_ms).toBe('number');
  });

  it('emits iteration_start and iteration_end for each iteration', async () => {
    const logger = makeSpyLogger();
    const step = makeStep({
      id: 'my-loop',
      loop: { max: 3 },
      steps: [{ id: 'body', command: 'echo hi', session: 'new', break_if: 'failure', continue_on_failure: true }],
    });
    const ctx = makeCtx({ auditLogger: logger });

    await executeLoopStep(step, ctx);

    const iterStarts = logger.events.filter(e => e.type === 'iteration_start');
    const iterEnds = logger.events.filter(e => e.type === 'iteration_end');
    expect(iterStarts.length).toBe(3);
    expect(iterEnds.length).toBe(3);

    // Check iteration indices
    expect(iterStarts[0]!.data.iteration).toBe(0);
    expect(iterStarts[1]!.data.iteration).toBe(1);
    expect(iterStarts[2]!.data.iteration).toBe(2);

    // Check context snapshot on start
    expect(iterStarts[0]!.data.context).toBeDefined();

    // Check end has outcome and duration
    expect(iterEnds[0]!.data.outcome).toBe('success');
    expect(typeof iterEnds[0]!.data.duration_ms).toBe('number');

    // Iteration end should not have context snapshot
    expect(iterEnds[0]!.data.context).toBeUndefined();
  });

  it('iteration events use correct nesting prefix', async () => {
    const logger = makeSpyLogger();
    const step = makeStep({
      id: 'my-loop',
      loop: { max: 2 },
      steps: [{ id: 'body', command: 'echo hi', session: 'new', break_if: 'failure', continue_on_failure: true }],
    });
    const ctx = makeCtx({ auditLogger: logger });

    await executeLoopStep(step, ctx);

    const iterStarts = logger.events.filter(e => e.type === 'iteration_start');
    // iteration context nesting includes the loop step with iteration index
    expect(iterStarts[0]!.prefix).toBe('[my-loop:0]');
    expect(iterStarts[1]!.prefix).toBe('[my-loop:1]');
  });

  it('iteration_end includes failed outcome when child step fails', async () => {
    spawnSpy.mockImplementation(() => makeMockProc(1) as never);

    const logger = makeSpyLogger();
    const step = makeStep({
      id: 'my-loop',
      loop: { max: 3 },
      steps: [{ id: 'body', command: 'echo hi', session: 'new' }],
    });
    const ctx = makeCtx({ auditLogger: logger });

    await executeLoopStep(step, ctx);

    const iterEnds = logger.events.filter(e => e.type === 'iteration_end');
    expect(iterEnds.length).toBe(1); // Only 1 iteration attempted before failure
    expect(iterEnds[0]!.data.outcome).toBe('failed');
  });

  it('step_end does not include context snapshot', async () => {
    const logger = makeSpyLogger();
    const step = makeStep({
      id: 'my-loop',
      loop: { max: 1 },
      steps: [{ id: 'body', command: 'echo hi', session: 'new', break_if: 'success' }],
    });
    const ctx = makeCtx({ auditLogger: logger, params: { env: 'staging' } });

    await executeLoopStep(step, ctx);

    const loopEnd = logger.events.find(e => e.type === 'step_end' && e.data.iterations_completed !== undefined);
    expect(loopEnd!.data.context).toBeUndefined();
  });

  it('loop-level events are in correct order: step_start, iteration pairs, step_end', async () => {
    const logger = makeSpyLogger();
    const step = makeStep({
      id: 'my-loop',
      loop: { max: 2 },
      steps: [{ id: 'body', command: 'echo hi', session: 'new', break_if: 'failure', continue_on_failure: true }],
    });
    const ctx = makeCtx({ auditLogger: logger });

    await executeLoopStep(step, ctx);

    // Filter only loop-level and iteration-level events (not child step events)
    const loopLevelEvents = logger.events.filter(e =>
      e.type === 'iteration_start' ||
      e.type === 'iteration_end' ||
      (e.type === 'step_start' && e.data.loop_type !== undefined) ||
      (e.type === 'step_end' && e.data.iterations_completed !== undefined)
    );
    const types = loopLevelEvents.map(e => e.type);
    expect(types[0]).toBe('step_start');
    expect(types[types.length - 1]).toBe('step_end');
    expect(types).toEqual([
      'step_start',
      'iteration_start', 'iteration_end',
      'iteration_start', 'iteration_end',
      'step_end',
    ]);
  });
});
