import { describe, expect, it } from 'bun:test';
import {
  createRootContext,
  createLoopIterationContext,
  createSubWorkflowContext,
  type ExecutionContext,
} from '../src/context.ts';
import { AuditLogger } from '../src/audit.ts';

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

describe('createRootContext with auditLogger', () => {
  it('stores auditLogger when provided', () => {
    const ctx = createRootContext({
      params: {},
      workflowFile: 'test.yaml',
      engine: null,
      auditLogger: {} as AuditLogger,
    });
    expect(ctx.auditLogger).toBeTruthy();
  });

  it('defaults auditLogger to null when not provided', () => {
    const ctx = createRootContext({
      params: {},
      workflowFile: 'test.yaml',
      engine: null,
    });
    expect(ctx.auditLogger).toBeNull();
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

  it('stores subWorkflowName on the nesting segment', () => {
    const parent = createRootContext({
      params: {},
      workflowFile: 'parent.yaml',
      engine: null,
    });

    const child = createSubWorkflowContext(parent, {
      stepId: 'deploy',
      params: {},
      workflowFile: 'child.yaml',
      subWorkflowName: 'deploy-sub',
    });

    const segment = child.nestingPath[child.nestingPath.length - 1];
    expect(segment?.subWorkflowName).toBe('deploy-sub');
  });

  it('inherits auditLogger from parent', () => {
    const mockLogger = {} as AuditLogger;
    const parent = createRootContext({
      params: {},
      workflowFile: 'parent.yaml',
      engine: null,
      auditLogger: mockLogger,
    });

    const child = createSubWorkflowContext(parent, {
      stepId: 'sub1',
      params: {},
      workflowFile: 'child.yaml',
    });

    expect(child.auditLogger).toBe(mockLogger);
  });
});

describe('createLoopIterationContext with auditLogger', () => {
  it('inherits auditLogger from parent', () => {
    const mockLogger = {} as AuditLogger;
    const parent = createRootContext({
      params: {},
      workflowFile: 'test.yaml',
      engine: null,
      auditLogger: mockLogger,
    });

    const child = createLoopIterationContext(parent, {
      stepId: 'loop1',
      iteration: 0,
    });

    expect(child.auditLogger).toBe(mockLogger);
  });
});

describe('_seed session propagation', () => {
  it('propagates _seed from parent to sub-workflow context', () => {
    const parent = createRootContext({
      params: {},
      workflowFile: 'parent.yaml',
      engine: null,
      sessionIds: { _seed: 'external-session-123' },
    });

    const child = createSubWorkflowContext(parent, {
      stepId: 'sub1',
      params: {},
      workflowFile: 'child.yaml',
    });

    expect(child.sessionIds).toEqual({ _seed: 'external-session-123' });
  });

  it('propagates _seed from parent to loop iteration context', () => {
    const parent = createRootContext({
      params: {},
      workflowFile: 'test.yaml',
      engine: null,
      sessionIds: { _seed: 'external-session-123' },
    });

    const child = createLoopIterationContext(parent, {
      stepId: 'loop1',
      iteration: 0,
    });

    expect(child.sessionIds).toEqual({ _seed: 'external-session-123' });
  });

  it('does not propagate non-seed session IDs to sub-workflow', () => {
    const parent = createRootContext({
      params: {},
      workflowFile: 'parent.yaml',
      engine: null,
      sessionIds: { 'step-1': 'sess-abc', _seed: 'seed-123' },
    });

    const child = createSubWorkflowContext(parent, {
      stepId: 'sub1',
      params: {},
      workflowFile: 'child.yaml',
    });

    expect(child.sessionIds).toEqual({ _seed: 'seed-123' });
  });

  it('does not propagate when no seed exists', () => {
    const parent = createRootContext({
      params: {},
      workflowFile: 'parent.yaml',
      engine: null,
      sessionIds: { 'step-1': 'sess-abc' },
    });

    const child = createSubWorkflowContext(parent, {
      stepId: 'sub1',
      params: {},
      workflowFile: 'child.yaml',
    });

    expect(child.sessionIds).toEqual({});
  });

  it('propagates _seed through nested sub-workflows', () => {
    const root = createRootContext({
      params: {},
      workflowFile: 'root.yaml',
      engine: null,
      sessionIds: { _seed: 'external-session-123' },
    });

    const mid = createSubWorkflowContext(root, {
      stepId: 'sub1',
      params: {},
      workflowFile: 'mid.yaml',
    });

    const leaf = createSubWorkflowContext(mid, {
      stepId: 'sub2',
      params: {},
      workflowFile: 'leaf.yaml',
    });

    expect(leaf.sessionIds).toEqual({ _seed: 'external-session-123' });
  });
});
