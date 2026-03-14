import type { ExecutionContext } from '../context.ts';
import type { Step } from '../schema.ts';

/**
 * Determine whether a step should be skipped based on its skip_if
 * condition and the execution context's lastStepOutcome.
 */
export function shouldSkip(step: Step, context: ExecutionContext): boolean {
  if (!step.skip_if) return false;

  if (step.skip_if === 'previous_success') {
    return context.lastStepOutcome === 'success';
  }

  return false;
}

/**
 * Evaluate whether a step's break_if condition is met.
 * Returns true if the loop should break.
 */
export function evaluateBreakIf(
  step: Step,
  outcome: 'success' | 'failed',
): boolean {
  if (!step.break_if) return false;

  if (step.break_if === 'success') return outcome === 'success';
  if (step.break_if === 'failure') return outcome === 'failed';

  return false;
}
