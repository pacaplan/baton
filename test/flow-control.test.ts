import { describe, expect, it } from 'bun:test';
import { shouldSkip } from '../src/shared/flow-control.ts';
import type { Step } from '../src/schema.ts';
import type { ExecutionContext } from '../src/context.ts';
import { createRootContext } from '../src/context.ts';

function makeCtx(
  lastOutcome: 'success' | 'failed' | null = null,
): ExecutionContext {
  const ctx = createRootContext({
    params: {},
    workflowFile: 'test.yaml',
    engine: null,
  });
  ctx.lastStepOutcome = lastOutcome;
  return ctx;
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'test-step',
    mode: 'shell',
    command: 'echo hi',
    session: 'new',
    ...overrides,
  };
}

describe('shouldSkip', () => {
  it('returns false when no skip_if', () => {
    const step = makeStep();
    const ctx = makeCtx('success');
    expect(shouldSkip(step, ctx)).toBe(false);
  });

  it('returns true when skip_if=previous_success and last outcome was success', () => {
    const step = makeStep({ skip_if: 'previous_success' });
    const ctx = makeCtx('success');
    expect(shouldSkip(step, ctx)).toBe(true);
  });

  it('returns false when skip_if=previous_success and last outcome was failed', () => {
    const step = makeStep({ skip_if: 'previous_success' });
    const ctx = makeCtx('failed');
    expect(shouldSkip(step, ctx)).toBe(false);
  });

  it('returns false when skip_if=previous_success and last outcome is null', () => {
    const step = makeStep({ skip_if: 'previous_success' });
    const ctx = makeCtx(null);
    expect(shouldSkip(step, ctx)).toBe(false);
  });
});
