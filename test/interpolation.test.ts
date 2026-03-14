import { describe, expect, it } from 'bun:test';
import { interpolate } from '../src/shared/interpolation.ts';
import type { ExecutionContext } from '../src/context.ts';
import { createRootContext } from '../src/context.ts';

function makeCtx(
  params: Record<string, string> = {},
  captured: Record<string, string> = {},
): ExecutionContext {
  const ctx = createRootContext({
    params,
    workflowFile: 'test.yaml',
    engine: null,
  });
  Object.assign(ctx.capturedVariables, captured);
  return ctx;
}

describe('interpolate', () => {
  it('replaces params in template', () => {
    const ctx = makeCtx({ name: 'world' });
    expect(interpolate('Hello {{name}}', ctx)).toBe('Hello world');
  });

  it('replaces captured variables in template', () => {
    const ctx = makeCtx({}, { output: 'captured-value' });
    expect(interpolate('Result: {{output}}', ctx)).toBe(
      'Result: captured-value',
    );
  });

  it('captured variables take precedence over params', () => {
    const ctx = makeCtx({ x: 'from-params' }, { x: 'from-capture' });
    expect(interpolate('{{x}}', ctx)).toBe('from-capture');
  });

  it('throws for undefined variable', () => {
    const ctx = makeCtx({});
    expect(() => interpolate('{{missing}}', ctx)).toThrow(
      'Undefined variable: {{missing}}',
    );
  });

  it('handles multiple placeholders', () => {
    const ctx = makeCtx({ a: '1', b: '2' });
    expect(interpolate('{{a}} and {{b}}', ctx)).toBe('1 and 2');
  });

  it('returns template unchanged when no placeholders', () => {
    const ctx = makeCtx({});
    expect(interpolate('no placeholders', ctx)).toBe('no placeholders');
  });
});
