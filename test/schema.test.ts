import { describe, expect, it } from 'bun:test';
import {
  ParamSchema,
  StepSchema,
  WorkflowSchema,
} from '../src/schema.ts';

describe('StepSchema', () => {
  it('accepts a valid shell step with command', () => {
    const result = StepSchema.parse({
      id: 'build',
      mode: 'shell',
      command: 'npm run build',
    });
    expect(result.id).toBe('build');
    expect(result.mode).toBe('shell');
    expect(result.command).toBe('npm run build');
    expect(result.session).toBe('new');
  });

  it('accepts a valid agent step with prompt', () => {
    const result = StepSchema.parse({
      id: 'implement',
      mode: 'interactive',
      prompt: 'Implement the feature',
    });
    expect(result.id).toBe('implement');
    expect(result.mode).toBe('interactive');
    expect(result.prompt).toBe('Implement the feature');
  });

  it('accepts a headless agent step', () => {
    const result = StepSchema.parse({
      id: 'review',
      mode: 'headless',
      prompt: 'Review the code',
      session: 'resume',
    });
    expect(result.mode).toBe('headless');
    expect(result.session).toBe('resume');
  });

  it('defaults session to "new"', () => {
    const result = StepSchema.parse({
      id: 'step1',
      mode: 'shell',
      command: 'echo hi',
    });
    expect(result.session).toBe('new');
  });

  it('rejects shell step without command', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad',
        mode: 'shell',
        prompt: 'not a command',
      }),
    ).toThrow();
  });

  it('rejects agent step without prompt', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad',
        mode: 'interactive',
        command: 'not a prompt',
      }),
    ).toThrow();
  });

  it('rejects invalid mode', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad',
        mode: 'invalid',
        prompt: 'hello',
      }),
    ).toThrow();
  });

  it('accepts a sub-workflow step with workflow field', () => {
    const result = StepSchema.parse({
      id: 'invoke',
      workflow: 'child.yaml',
    });
    expect(result.workflow).toBe('child.yaml');
  });

  it('accepts a sub-workflow step with params', () => {
    const result = StepSchema.parse({
      id: 'invoke',
      workflow: 'child.yaml',
      params: { task: 'build' },
    });
    expect(result.params).toEqual({ task: 'build' });
  });

  it('rejects workflow step with command', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad',
        workflow: 'child.yaml',
        command: 'echo hi',
      }),
    ).toThrow(/exactly one/);
  });

  it('rejects workflow step with prompt', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad',
        workflow: 'child.yaml',
        prompt: 'do something',
      }),
    ).toThrow(/exactly one/);
  });

  it('rejects workflow step with mode', () => {
    expect(() =>
      StepSchema.parse({
        id: 'bad',
        workflow: 'child.yaml',
        mode: 'interactive',
      }),
    ).toThrow(/exactly one/);
  });
});

describe('ParamSchema', () => {
  it('parses a required param', () => {
    const result = ParamSchema.parse({ name: 'project' });
    expect(result.name).toBe('project');
    expect(result.required).toBe(true);
    expect(result.default).toBeUndefined();
  });

  it('parses an optional param with default', () => {
    const result = ParamSchema.parse({
      name: 'env',
      required: false,
      default: 'staging',
    });
    expect(result.required).toBe(false);
    expect(result.default).toBe('staging');
  });

  it('defaults required to true', () => {
    const result = ParamSchema.parse({ name: 'x' });
    expect(result.required).toBe(true);
  });
});

describe('WorkflowSchema', () => {
  it('parses a full workflow', () => {
    const result = WorkflowSchema.parse({
      name: 'deploy',
      description: 'Deploy pipeline',
      params: [{ name: 'target' }],
      steps: [{ id: 'build', mode: 'shell', command: 'make' }],
    });
    expect(result.name).toBe('deploy');
    expect(result.description).toBe('Deploy pipeline');
    expect(result.agent).toBe('claude-code');
    expect(result.params).toHaveLength(1);
    expect(result.steps).toHaveLength(1);
  });

  it('applies default agent and empty params', () => {
    const result = WorkflowSchema.parse({
      name: 'simple',
      steps: [{ id: 's1', mode: 'shell', command: 'echo hi' }],
    });
    expect(result.agent).toBe('claude-code');
    expect(result.params).toEqual([]);
  });

  it('rejects workflow with no steps', () => {
    expect(() =>
      WorkflowSchema.parse({
        name: 'empty',
        steps: [],
      }),
    ).toThrow();
  });

  it('rejects workflow without name', () => {
    expect(() =>
      WorkflowSchema.parse({
        steps: [{ id: 's1', mode: 'shell', command: 'echo' }],
      }),
    ).toThrow();
  });

  it('accepts workflow with engine block', () => {
    const result = WorkflowSchema.parse({
      name: 'engine-wf',
      steps: [{ id: 's1', mode: 'shell', command: 'echo hi' }],
      engine: { type: 'openspec', change_param: 'change_name' },
    });
    expect(result.engine).toEqual({ type: 'openspec', change_param: 'change_name' });
  });

  it('accepts workflow without engine block', () => {
    const result = WorkflowSchema.parse({
      name: 'no-engine',
      steps: [{ id: 's1', mode: 'shell', command: 'echo hi' }],
    });
    expect(result.engine).toBeUndefined();
  });

  it('rejects engine block missing type', () => {
    expect(() =>
      WorkflowSchema.parse({
        name: 'bad-engine',
        steps: [{ id: 's1', mode: 'shell', command: 'echo hi' }],
        engine: { change_param: 'change_name' },
      }),
    ).toThrow();
  });
});
