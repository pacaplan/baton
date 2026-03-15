import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { join } from 'node:path';
import {
  createRootContext,
  createSubWorkflowContext,
  type ExecutionContext,
} from '../src/context.ts';
import type { AuditEvent } from '../src/audit.ts';

import { executeSubWorkflowStep } from '../src/executors/sub-workflow.ts';

const PROJECT_ROOT = join(import.meta.dir, '..');
const PARENT_WORKFLOW = join(PROJECT_ROOT, 'parent.yaml');

function makeSpyLogger() {
  const events: AuditEvent[] = [];
  return {
    events,
    emit(event: AuditEvent) { events.push(event); },
    close() {},
  };
}

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

describe('SubWorkflowExecutor: audit events', () => {
  beforeEach(() => {
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
  });

  it('emits step_start with resolved workflow path and interpolated params', async () => {
    const logger = makeSpyLogger();
    const parentCtx = createRootContext({
      params: { greeting: 'hello-from-parent' },
      workflowFile: PARENT_WORKFLOW,
      engine: null,
      auditLogger: logger,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-with-params.yaml',
      params: { msg: '{{greeting}}' },
    };

    await executeSubWorkflowStep(step, parentCtx);

    const stepStart = logger.events.find(e =>
      e.type === 'step_start' && e.data.workflow_path !== undefined
    );
    expect(stepStart).toBeTruthy();
    expect(stepStart!.data.workflow_path).toContain('sub-workflow-with-params.yaml');
    expect(stepStart!.data.params).toEqual({ msg: 'hello-from-parent' });
    expect(stepStart!.data.context).toEqual({
      params: { greeting: 'hello-from-parent' },
      capturedVariables: {},
    });
  });

  it('emits step_end with outcome and duration', async () => {
    const logger = makeSpyLogger();
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
      auditLogger: logger,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-child.yaml',
    };

    await executeSubWorkflowStep(step, parentCtx);

    // Find the sub-workflow step_end (has no shell-specific fields like exit_code or command)
    const stepEnd = logger.events.filter(e => e.type === 'step_end').pop();
    expect(stepEnd).toBeTruthy();
    expect(stepEnd!.data.outcome).toBe('success');
    expect(typeof stepEnd!.data.duration_ms).toBe('number');
    // End events should not have context snapshot
    expect(stepEnd!.data.context).toBeUndefined();
  });

  it('emits sub_workflow_start and sub_workflow_end around child execution', async () => {
    const logger = makeSpyLogger();
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
      auditLogger: logger,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-child.yaml',
    };

    await executeSubWorkflowStep(step, parentCtx);

    const subStarts = logger.events.filter(e => e.type === 'sub_workflow_start');
    const subEnds = logger.events.filter(e => e.type === 'sub_workflow_end');
    expect(subStarts.length).toBe(1);
    expect(subEnds.length).toBe(1);

    // sub_workflow_start includes context snapshot
    expect(subStarts[0]!.data.context).toBeDefined();

    // sub_workflow_end includes outcome and duration, no context
    expect(subEnds[0]!.data.outcome).toBe('success');
    expect(typeof subEnds[0]!.data.duration_ms).toBe('number');
    expect(subEnds[0]!.data.context).toBeUndefined();
  });

  it('sub_workflow_start uses child context nesting prefix', async () => {
    const logger = makeSpyLogger();
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
      auditLogger: logger,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-child.yaml',
    };

    await executeSubWorkflowStep(step, parentCtx);

    const subStart = logger.events.find(e => e.type === 'sub_workflow_start');
    // Child context prefix includes the sub-workflow step and sub:workflowName
    expect(subStart!.prefix).toContain('run-sub');
    expect(subStart!.prefix).toContain('sub:sub-workflow-child');
  });

  it('events are in correct order: step_start, sub_workflow_start, child events, sub_workflow_end, step_end', async () => {
    const logger = makeSpyLogger();
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
      auditLogger: logger,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-child.yaml',
    };

    await executeSubWorkflowStep(step, parentCtx);

    const types = logger.events.map(e => e.type);
    // First event should be step_start (parent-level)
    expect(types[0]).toBe('step_start');
    // Second should be sub_workflow_start
    expect(types[1]).toBe('sub_workflow_start');
    // Last should be step_end (parent-level)
    expect(types[types.length - 1]).toBe('step_end');
    // Second-to-last should be sub_workflow_end
    expect(types[types.length - 2]).toBe('sub_workflow_end');
  });

  it('includes subWorkflowName in nesting prefix for child step events', async () => {
    const logger = makeSpyLogger();
    const parentCtx = createRootContext({
      params: {},
      workflowFile: PARENT_WORKFLOW,
      engine: null,
      auditLogger: logger,
    });

    const step = {
      id: 'run-sub',
      session: 'new' as const,
      workflow: 'test/fixtures/sub-workflow-child.yaml',
    };

    await executeSubWorkflowStep(step, parentCtx);

    // Find child step events (step_start/step_end for child-echo)
    const childStepStart = logger.events.find(e =>
      e.type === 'step_start' && e.data.command !== undefined
    );
    // Child step prefix should include run-sub, sub:sub-workflow-child, child-echo
    expect(childStepStart).toBeTruthy();
    expect(childStepStart!.prefix).toContain('run-sub');
    expect(childStepStart!.prefix).toContain('sub:sub-workflow-child');
    expect(childStepStart!.prefix).toContain('child-echo');
  });
});
