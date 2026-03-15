import { describe, expect, it } from 'bun:test';
import { StepSchema, WorkflowSchema, SessionStrategy } from '../src/schema.ts';

describe('SessionStrategy extensions', () => {
  it('accepts "inherit" as a session strategy', () => {
    const result = SessionStrategy.parse('inherit');
    expect(result).toBe('inherit');
  });
});

describe('StepSchema extensions', () => {
  it('accepts a shell step with capture field', () => {
    const result = StepSchema.parse({
      id: 'run-gauntlet',
      mode: 'shell',
      command: 'echo hello',
      capture: 'gauntlet_output',
    });
    expect(result.capture).toBe('gauntlet_output');
  });

  it('rejects capture on an agent step', () => {
    expect(() =>
      StepSchema.parse({
        id: 'agent-step',
        mode: 'headless',
        prompt: 'Do things',
        capture: 'output',
      }),
    ).toThrow();
  });

  it('rejects capture on an interactive step', () => {
    expect(() =>
      StepSchema.parse({
        id: 'agent-step',
        mode: 'interactive',
        prompt: 'Do things',
        capture: 'output',
      }),
    ).toThrow();
  });

  it('accepts continue_on_failure on a shell step', () => {
    const result = StepSchema.parse({
      id: 'risky',
      mode: 'shell',
      command: 'exit 1',
      continue_on_failure: true,
    });
    expect(result.continue_on_failure).toBe(true);
  });

  it('accepts skip_if with value previous_success', () => {
    const result = StepSchema.parse({
      id: 'fix',
      mode: 'shell',
      command: 'fix things',
      skip_if: 'previous_success',
    });
    expect(result.skip_if).toBe('previous_success');
  });

  it('rejects skip_if with invalid value', () => {
    expect(() =>
      StepSchema.parse({
        id: 'fix',
        mode: 'shell',
        command: 'fix things',
        skip_if: 'invalid_value',
      }),
    ).toThrow();
  });

  it('accepts break_if with value success', () => {
    const result = StepSchema.parse({
      id: 'check',
      mode: 'shell',
      command: 'check things',
      break_if: 'success',
    });
    expect(result.break_if).toBe('success');
  });

  it('accepts break_if with value failure', () => {
    const result = StepSchema.parse({
      id: 'check',
      mode: 'shell',
      command: 'check things',
      break_if: 'failure',
    });
    expect(result.break_if).toBe('failure');
  });

  it('accepts model on an agent step', () => {
    const result = StepSchema.parse({
      id: 'smart-step',
      mode: 'headless',
      prompt: 'Think hard',
      model: 'opus',
    });
    expect(result.model).toBe('opus');
  });

  it('rejects model on a shell step', () => {
    expect(() =>
      StepSchema.parse({
        id: 'shell-step',
        mode: 'shell',
        command: 'echo hi',
        model: 'opus',
      }),
    ).toThrow();
  });

  it('accepts steps field for nested steps (group)', () => {
    const result = StepSchema.parse({
      id: 'group',
      steps: [
        { id: 'child1', mode: 'shell', command: 'echo 1' },
        { id: 'child2', mode: 'shell', command: 'echo 2' },
      ],
    });
    expect(result.steps).toHaveLength(2);
  });

  it('accepts loop with steps', () => {
    const result = StepSchema.parse({
      id: 'loop-step',
      loop: { max: 3 },
      steps: [
        { id: 'body', mode: 'shell', command: 'echo iteration' },
      ],
    });
    expect(result.loop?.max).toBe(3);
    expect(result.steps).toHaveLength(1);
  });

  it('accepts loop with over and as', () => {
    const result = StepSchema.parse({
      id: 'for-each',
      loop: { over: 'task_files', as: 'task_file' },
      steps: [
        { id: 'run-task', mode: 'shell', command: 'echo {{task_file}}' },
      ],
    });
    expect(result.loop?.over).toBe('task_files');
    expect(result.loop?.as).toBe('task_file');
  });

  it('rejects loop without max and without over+as', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad-loop',
        loop: {},
        steps: [
          { id: 'body', mode: 'shell', command: 'echo hi' },
        ],
      }),
    ).toThrow();
  });

  it('accepts workflow field for sub-workflow step', () => {
    const result = StepSchema.parse({
      id: 'sub',
      workflow: 'workflows/sub.yaml',
    });
    expect(result.workflow).toBe('workflows/sub.yaml');
  });

  it('accepts params on a sub-workflow step', () => {
    const result = StepSchema.parse({
      id: 'sub',
      workflow: 'workflows/sub.yaml',
      params: { task_file: '{{task_file}}' },
    });
    expect(result.params).toEqual({ task_file: '{{task_file}}' });
  });

  it('rejects step with both command and prompt', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad',
        mode: 'shell',
        command: 'echo hi',
        prompt: 'do stuff',
      }),
    ).toThrow();
  });

  it('rejects step with both command and workflow', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad',
        mode: 'shell',
        command: 'echo hi',
        workflow: 'some.yaml',
      }),
    ).toThrow();
  });

  it('rejects step with neither command, prompt, workflow, nor steps', () => {
    expect(() =>
      StepSchema.parse({
        id: 'empty',
      }),
    ).toThrow();
  });

  it('accepts session: inherit', () => {
    const result = StepSchema.parse({
      id: 'inherit-step',
      mode: 'headless',
      prompt: 'Continue from parent',
      session: 'inherit',
    });
    expect(result.session).toBe('inherit');
  });
});

describe('WorkflowSchema with new step types', () => {
  it('accepts a workflow with loop steps', () => {
    const result = WorkflowSchema.parse({
      name: 'loop-wf',
      steps: [
        {
          id: 'retry-loop',
          loop: { max: 3 },
          steps: [
            { id: 'try', mode: 'shell', command: 'echo try' },
          ],
        },
      ],
    });
    expect(result.steps).toHaveLength(1);
  });

  it('accepts a workflow with sub-workflow steps', () => {
    const result = WorkflowSchema.parse({
      name: 'parent-wf',
      steps: [
        { id: 'sub', workflow: 'workflows/child.yaml' },
      ],
    });
    expect(result.steps).toHaveLength(1);
  });

  it('accepts a workflow with group steps (steps without loop)', () => {
    const result = WorkflowSchema.parse({
      name: 'grouped-wf',
      steps: [
        {
          id: 'phase1',
          steps: [
            { id: 'a', mode: 'shell', command: 'echo a' },
            { id: 'b', mode: 'shell', command: 'echo b' },
          ],
        },
      ],
    });
    expect(result.steps).toHaveLength(1);
  });
});
