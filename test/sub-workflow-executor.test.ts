import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { join } from 'node:path';
import {
  createRootContext,
  createSubWorkflowContext,
  type ExecutionContext,
} from '../src/context.ts';

import { executeSubWorkflowStep } from '../src/executors/sub-workflow.ts';

const PROJECT_ROOT = join(import.meta.dir, '..');
const PARENT_WORKFLOW = join(PROJECT_ROOT, 'parent.yaml');

describe('SubWorkflowExecutor', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
  });

  it('executes a sub-workflow with shell steps', async () => {
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-child.yaml',
    };

    const outcome = await executeSubWorkflowStep(step, parentCtx);
    expect(outcome).toBe('success');
  });

  it('passes params to sub-workflow via interpolation', async () => {
    const parentCtx = createRootContext({
      params: { greeting: 'hello-from-parent' },
      workflowFile: PARENT_WORKFLOW,
      engine: null,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-with-params.yaml',
      params: { msg: '{{greeting}}' },
    };

    const outcome = await executeSubWorkflowStep(step, parentCtx);
    expect(outcome).toBe('success');
  });

  it('fails with descriptive error for missing sub-workflow file', async () => {
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/nonexistent-workflow.yaml',
    };

    await expect(
      executeSubWorkflowStep(step, parentCtx),
    ).rejects.toThrow(/nonexistent-workflow\.yaml/);
  });

  it('fails when sub-workflow has missing required params', async () => {
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-with-params.yaml',
      // Not passing required 'msg' param
    };

    await expect(
      executeSubWorkflowStep(step, parentCtx),
    ).rejects.toThrow(/Missing required parameter/);
  });

  it('sub-workflow does not inherit parent params implicitly', async () => {
    const parentCtx = createRootContext({
      params: { secret: 'parent-only-value' },
      workflowFile: PARENT_WORKFLOW,
      engine: null,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-uses-secret.yaml',
      // Not passing 'secret' param
    };

    // Sub-workflow tries to use {{secret}} which should throw
    // because the child context does not have the parent's params
    await expect(
      executeSubWorkflowStep(step, parentCtx),
    ).rejects.toThrow(/secret/);
  });

  it('captured variables in sub-workflow do not leak to parent', async () => {
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-captures.yaml',
    };

    const outcome = await executeSubWorkflowStep(step, parentCtx);
    expect(outcome).toBe('success');
    // Parent context should not have the captured variable
    expect(parentCtx.capturedVariables['sub_capture']).toBeUndefined();
  });

  it('creates child context with correct nesting path', async () => {
    const parentCtx = createRootContext({
      params: {},
      workflowFile: '/parent.yaml',
      engine: null,
    });

    const childCtx = createSubWorkflowContext(parentCtx, {
      stepId: 'run-sub',
      params: { x: 'y' },
      workflowFile: '/child.yaml',
    });

    expect(childCtx.nestingPath).toEqual([{ stepId: 'run-sub' }]);
    expect(childCtx.params).toEqual({ x: 'y' });
    expect(childCtx.sessionIds).toEqual({});
    expect(childCtx.capturedVariables).toEqual({});
    expect(childCtx.parentContext).toBe(parentCtx);
    expect(childCtx.workflowFile).toBe('/child.yaml');
  });

  it('interpolates workflow path with {{var}}', async () => {
    const parentCtx = createRootContext({
      params: { child_name: 'sub-workflow-child' },
      workflowFile: PARENT_WORKFLOW,
      engine: null,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/{{child_name}}.yaml',
    };

    const outcome = await executeSubWorkflowStep(step, parentCtx);
    expect(outcome).toBe('success');
  });
});
