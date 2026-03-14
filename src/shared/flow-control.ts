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
