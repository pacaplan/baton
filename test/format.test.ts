import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import type { NestingSegment } from '../src/context.ts';
import {
  buildBreadcrumb,
  printSeparator,
  printStepHeading,
} from '../src/format.ts';

describe('buildBreadcrumb', () => {
  it('returns just the step id for a top-level step', () => {
    const result = buildBreadcrumb([], 'validate');
    expect(result).toBe('validate');
  });

  it('returns breadcrumb for a step inside a loop iteration', () => {
    const nestingPath: NestingSegment[] = [
      { stepId: 'task-loop', iteration: 0 },
    ];
    const result = buildBreadcrumb(nestingPath, 'implement');
    expect(result).toBe('task-loop > iteration 1 > implement');
  });

  it('returns breadcrumb for a step inside a sub-workflow inside a loop', () => {
    const nestingPath: NestingSegment[] = [
      { stepId: 'task-loop', iteration: 0 },
      { stepId: 'verify', subWorkflowName: 'verify-task' },
    ];
    const result = buildBreadcrumb(nestingPath, 'check');
    expect(result).toBe(
      'task-loop > iteration 1 > verify > verify-task > check',
    );
  });

  it('returns breadcrumb for plain nesting segment (no loop, no sub-workflow)', () => {
    const nestingPath: NestingSegment[] = [{ stepId: 'parent' }];
    const result = buildBreadcrumb(nestingPath, 'child');
    expect(result).toBe('parent > child');
  });

  it('converts 0-indexed iteration to 1-indexed display', () => {
    const nestingPath: NestingSegment[] = [
      { stepId: 'loop', iteration: 4 },
    ];
    const result = buildBreadcrumb(nestingPath, 'step');
    expect(result).toBe('loop > iteration 5 > step');
  });
});

describe('printSeparator', () => {
  let logged: string[];
  const originalLog = console.log;

  beforeEach(() => {
    logged = [];
    console.log = mock((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it('prints a fixed-width line of ━ characters', () => {
    printSeparator();
    expect(logged.length).toBe(1);
    expect(logged[0]).toMatch(/^━+$/);
    expect(logged[0]!.length).toBe(60);
  });
});

describe('printStepHeading', () => {
  let logged: string[];
  const originalLog = console.log;

  beforeEach(() => {
    logged = [];
    console.log = mock((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    console.log = originalLog;
  });

  // Scenario: Top-level step heading
  it('prints heading for a top-level step', () => {
    printStepHeading(0, 5, 'validate', 'shell', false);
    expect(logged[0]).toBe('━━ step 1/5: validate [shell] ━━');
  });

  // Scenario: Step inside a loop iteration
  it('prints heading for a step inside a loop', () => {
    printStepHeading(
      0,
      3,
      'task-loop > iteration 1 > implement',
      'headless',
      false,
    );
    expect(logged[0]).toBe(
      '━━ step 1/3: task-loop > iteration 1 > implement [headless] ━━',
    );
  });

  // Scenario: Step inside a sub-workflow inside a loop
  it('prints heading for a step inside a sub-workflow inside a loop', () => {
    printStepHeading(
      0,
      2,
      'task-loop > iteration 1 > verify > verify-task > check',
      'shell',
      false,
    );
    expect(logged[0]).toBe(
      '━━ step 1/2: task-loop > iteration 1 > verify > verify-task > check [shell] ━━',
    );
  });

  // Scenario: Skipped step heading
  it('prints heading with [skipped] for skipped steps', () => {
    printStepHeading(2, 5, 'deploy', 'shell', true);
    expect(logged[0]).toBe('━━ step 3/5: deploy [skipped] ━━');
  });

  it('converts 0-based index to 1-based display', () => {
    printStepHeading(4, 10, 'final', 'agent', false);
    expect(logged[0]).toBe('━━ step 5/10: final [agent] ━━');
  });
});
