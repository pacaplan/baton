import { describe, expect, it } from 'bun:test';
import { evaluateBreakIf } from '../src/shared/flow-control.ts';
import type { Step } from '../src/schema.ts';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'test-step',
    mode: 'shell',
    command: 'echo hi',
    session: 'new',
    ...overrides,
  };
}

describe('evaluateBreakIf', () => {
  it('returns true when break_if=success and outcome is success', () => {
    const step = makeStep({ break_if: 'success' });
    expect(evaluateBreakIf(step, 'success')).toBe(true);
  });

  it('returns false when break_if=success and outcome is failed', () => {
    const step = makeStep({ break_if: 'success' });
    expect(evaluateBreakIf(step, 'failed')).toBe(false);
  });

  it('returns true when break_if=failure and outcome is failed', () => {
    const step = makeStep({ break_if: 'failure' });
    expect(evaluateBreakIf(step, 'failed')).toBe(true);
  });

  it('returns false when break_if=failure and outcome is success', () => {
    const step = makeStep({ break_if: 'failure' });
    expect(evaluateBreakIf(step, 'success')).toBe(false);
  });

  it('returns false when no break_if is set', () => {
    const step = makeStep();
    expect(evaluateBreakIf(step, 'success')).toBe(false);
  });
});
