import { describe, expect, it, spyOn } from 'bun:test';
import {
  createRootContext,
  createSubWorkflowContext,
  type ExecutionContext,
} from '../src/context.ts';
import {
  resolveInheritSession,
  resolveResumeSession,
} from '../src/shared/session.ts';

describe('session: inherit', () => {
  it('walks parent context chain to find parent session', () => {
    const parentCtx = createRootContext({
      params: {},
      workflowFile: '/parent.yaml',
      engine: null,
    });
    parentCtx.sessionIds['agent-step'] = 'sess-parent-123';

    const childCtx = createSubWorkflowContext(parentCtx, {
      stepId: 'run-sub',
      params: {},
      workflowFile: '/child.yaml',
    });

    const sessionId = resolveInheritSession(childCtx);
    expect(sessionId).toBe('sess-parent-123');
  });

  it('returns most recent parent session when multiple exist', () => {
    const parentCtx = createRootContext({
      params: {},
      workflowFile: '/parent.yaml',
      engine: null,
    });
    parentCtx.sessionIds['step-1'] = 'sess-first';
    parentCtx.sessionIds['step-2'] = 'sess-second';

    const childCtx = createSubWorkflowContext(parentCtx, {
      stepId: 'run-sub',
      params: {},
      workflowFile: '/child.yaml',
    });

    const sessionId = resolveInheritSession(childCtx);
    expect(sessionId).toBe('sess-second');
  });

  it('errors when no parent session exists', () => {
    const parentCtx = createRootContext({
      params: {},
      workflowFile: '/parent.yaml',
      engine: null,
    });

    const childCtx = createSubWorkflowContext(parentCtx, {
      stepId: 'run-sub',
      params: {},
      workflowFile: '/child.yaml',
    });

    expect(() => resolveInheritSession(childCtx)).toThrow(
      /no parent session/i,
    );
  });

  it('warns and returns empty string when used in top-level workflow (no parent context)', () => {
    const topCtx = createRootContext({
      params: {},
      workflowFile: '/top.yaml',
      engine: null,
    });

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const result = resolveInheritSession(topCtx);
    expect(result).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no parent workflow'),
    );
    warnSpy.mockRestore();
  });

  it('walks through nested sub-workflows to find session', () => {
    const grandparentCtx = createRootContext({
      params: {},
      workflowFile: '/grandparent.yaml',
      engine: null,
    });
    grandparentCtx.sessionIds['gp-step'] = 'sess-gp';

    const parentCtx = createSubWorkflowContext(grandparentCtx, {
      stepId: 'run-parent',
      params: {},
      workflowFile: '/parent.yaml',
    });
    parentCtx.sessionIds['p-step'] = 'sess-parent';

    const childCtx = createSubWorkflowContext(parentCtx, {
      stepId: 'run-child',
      params: {},
      workflowFile: '/child.yaml',
    });

    // Should get the parent's session (first different workflowFile)
    const sessionId = resolveInheritSession(childCtx);
    expect(sessionId).toBe('sess-parent');
  });
});

describe('session: resume scoping', () => {
  it('resumes session from same workflow file', () => {
    const ctx = createRootContext({
      params: {},
      workflowFile: '/workflow.yaml',
      engine: null,
    });
    ctx.sessionIds['step-1'] = 'sess-abc';

    const sessionId = resolveResumeSession(ctx);
    expect(sessionId).toBe('sess-abc');
  });

  it('returns most recent session from same workflow', () => {
    const ctx = createRootContext({
      params: {},
      workflowFile: '/workflow.yaml',
      engine: null,
    });
    ctx.sessionIds['step-1'] = 'sess-first';
    ctx.sessionIds['step-2'] = 'sess-second';

    const sessionId = resolveResumeSession(ctx);
    expect(sessionId).toBe('sess-second');
  });

  it('errors when no session exists in current workflow', () => {
    const ctx = createRootContext({
      params: {},
      workflowFile: '/workflow.yaml',
      engine: null,
    });

    expect(() => resolveResumeSession(ctx)).toThrow(
      /no prior session/i,
    );
  });

  it('does not cross sub-workflow boundaries', () => {
    // Parent has sessions, then invokes sub-workflow which completes,
    // then parent tries resume - should only see parent's own sessions
    const parentCtx = createRootContext({
      params: {},
      workflowFile: '/parent.yaml',
      engine: null,
    });
    parentCtx.sessionIds['parent-agent'] = 'sess-parent';

    // Sub-workflow context had sessions but they're discarded after completion
    // The parent context only sees its own sessionIds

    const sessionId = resolveResumeSession(parentCtx);
    expect(sessionId).toBe('sess-parent');
  });
});
