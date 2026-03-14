import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { interpolateParams, loadWorkflow } from '../src/loader.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

describe('loadWorkflow', () => {
  it('loads a valid workflow from YAML', () => {
    const wf = loadWorkflow(join(FIXTURES, 'valid-workflow.yaml'));
    expect(wf.name).toBe('test-workflow');
    expect(wf.description).toBe('A test workflow');
    expect(wf.params).toHaveLength(2);
    expect(wf.steps).toHaveLength(2);
    expect(wf.steps[0]?.mode).toBe('shell');
    expect(wf.steps[1]?.mode).toBe('headless');
  });

  it('loads a minimal workflow with defaults', () => {
    const wf = loadWorkflow(join(FIXTURES, 'minimal-workflow.yaml'));
    expect(wf.name).toBe('minimal');
    expect(wf.agent).toBe('claude-code');
    expect(wf.params).toEqual([]);
    expect(wf.steps).toHaveLength(1);
  });

  it('throws for workflow with empty steps', () => {
    expect(() =>
      loadWorkflow(join(FIXTURES, 'invalid-no-steps.yaml')),
    ).toThrow();
  });

  it('throws for shell step without command', () => {
    expect(() =>
      loadWorkflow(join(FIXTURES, 'invalid-shell-no-command.yaml')),
    ).toThrow();
  });

  it('throws for non-existent file', () => {
    expect(() => loadWorkflow('/nonexistent/file.yaml')).toThrow();
  });
});

describe('interpolateParams', () => {
  it('replaces all placeholders', () => {
    const result = interpolateParams(
      'Deploy {{project}} to {{env}}',
      { project: 'acme', env: 'prod' },
    );
    expect(result).toBe('Deploy acme to prod');
  });

  it('returns string unchanged when no placeholders', () => {
    const result = interpolateParams('no placeholders here', {});
    expect(result).toBe('no placeholders here');
  });

  it('throws for missing parameter', () => {
    expect(() =>
      interpolateParams('Hello {{name}}', {}),
    ).toThrow('Missing parameter: {{name}}');
  });

  it('replaces duplicate placeholders', () => {
    const result = interpolateParams(
      '{{x}} and {{x}}',
      { x: 'val' },
    );
    expect(result).toBe('val and val');
  });
});
