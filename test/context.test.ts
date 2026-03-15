import { describe, expect, it } from 'bun:test';
import {
  createRootContext,
  createLoopIterationContext,
  createSubWorkflowContext,
  type ExecutionContext,
} from '../src/context.ts';

describe('createRootContext', () => {
  it('creates a context with provided params', () => {
    const ctx = createRootContext({
      params: { name: 'test' },
      workflowFile: 'test.yaml',
      engine: null,
    });
    expect(ctx.params).toEqual({ name: 'test' });
    expect(ctx.sessionIds).toEqual({});
    expect(ctx.capturedVariables).toEqual({});
    expect(ctx.lastStepOutcome).toBeNull();
    expect(ctx.nestingPath).toEqual([]);
    expect(ctx.parentContext).toBeNull();
    expect(ctx.workflowFile).toBe('test.yaml');
  });

  it('restores session IDs from options', () => {
    const ctx = createRootContext({
      params: {},
      workflowFile: 'test.yaml',
      engine: null,
      sessionIds: { step1: 'sess-123' },
    });
    expect(ctx.sessionIds).toEqual({ step1: 'sess-123' });
  });

  it('restores captured variables from options', () => {
    const ctx = createRootContext({
      params: {},
      workflowFile: 'test.yaml',
      engine: null,
      capturedVariables: { output: 'hello' },
    });
    expect(ctx.capturedVariables).toEqual({ output: 'hello' });
  });
});

describe('createLoopIterationContext', () => {
  it('creates child context with loop variable in params', () => {
    const parent = createRootContext({
      params: { name: 'test' },
      workflowFile: 'test.yaml',
      engine: null,
    });

    const child = createLoopIterationContext(parent, {
      stepId: 'loop1',
      iteration: 0,
      loopVar: { task_file: 'file1.md' },
    });

    expect(child.params).toEqual({ name: 'test', task_file: 'file1.md' });
    expect(child.sessionIds).toEqual({});
    expect(child.capturedVariables).toEqual({});
    expect(child.lastStepOutcome).toBeNull();
    expect(child.parentContext).toBe(parent);
    expect(child.nestingPath).toEqual([
      { stepId: 'loop1', iteration: 0, loopVar: { task_file: 'file1.md' } },
    ]);
  });

  it('does not mutate parent context', () => {
    const parent = createRootContext({
      params: { x: '1' },
      workflowFile: 'test.yaml',
      engine: null,
    });

    createLoopIterationContext(parent, {
      stepId: 'loop1',
      iteration: 0,
      loopVar: { y: '2' },
    });

    expect(parent.params).toEqual({ x: '1' });
    expect(parent.nestingPath).toEqual([]);
  });
});

describe('createSubWorkflowContext', () => {
  it('creates child context with only explicit params', () => {
    const parent = createRootContext({
      params: { name: 'test', extra: 'value' },
      workflowFile: 'parent.yaml',
      engine: null,
    });
    parent.capturedVariables['output'] = 'captured';

    const child = createSubWorkflowContext(parent, {
      stepId: 'sub1',
      params: { task: 'do-thing' },
      workflowFile: 'child.yaml',
    });

    expect(child.params).toEqual({ task: 'do-thing' });
    expect(child.capturedVariables).toEqual({});
    expect(child.sessionIds).toEqual({});
    expect(child.parentContext).toBe(parent);
    expect(child.workflowFile).toBe('child.yaml');
  });
});
