import type { NestingSegment } from './context.ts';

const SEPARATOR_WIDTH = 60;

/**
 * Build a human-readable breadcrumb from the nesting path and current step ID.
 *
 * Examples:
 * - [] + 'validate' → 'validate'
 * - [{stepId: "task-loop", iteration: 0}] + 'implement' → 'task-loop > iteration 1 > implement'
 * - [{stepId: "task-loop", iteration: 0}, {stepId: "verify", subWorkflowName: "verify-task"}] + 'check'
 *   → 'task-loop > iteration 1 > verify > verify-task > check'
 */
export function buildBreadcrumb(
  nestingPath: NestingSegment[],
  stepId: string,
): string {
  const parts: string[] = [];

  for (const segment of nestingPath) {
    parts.push(segment.stepId);

    if (segment.iteration !== undefined) {
      parts.push(`iteration ${segment.iteration + 1}`);
    }

    if (segment.subWorkflowName) {
      parts.push(segment.subWorkflowName);
    }
  }

  parts.push(stepId);
  return parts.join(' > ');
}

/** Print a fixed-width horizontal rule of ━ characters to stdout. */
export function printSeparator(): void {
  console.log('━'.repeat(SEPARATOR_WIDTH));
}

/**
 * Print a formatted step heading.
 * Non-skipped: ━━ step N/M: breadcrumb [type] ━━
 * Skipped:     ━━ step N/M: breadcrumb [skipped] ━━
 */
export function printStepHeading(
  index: number,
  total: number,
  breadcrumb: string,
  stepType: string,
  skipped: boolean,
): void {
  const label = skipped ? 'skipped' : stepType;
  console.log(`━━ step ${index + 1}/${total}: ${breadcrumb} [${label}] ━━`);
}
