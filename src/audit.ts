import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NestingSegment } from './context.ts';

export type AuditEventType =
  | 'run_start'
  | 'run_end'
  | 'step_start'
  | 'step_end'
  | 'iteration_start'
  | 'iteration_end'
  | 'sub_workflow_start'
  | 'sub_workflow_end'
  | 'error';

export interface AuditEvent {
  timestamp: string;
  prefix: string;
  type: AuditEventType;
  data: Record<string, unknown>;
}

export class AuditLogger {
  private fd: number;
  private closed = false;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.fd = openSync(filePath, 'a');
  }

  emit(event: AuditEvent): void {
    if (this.closed) return;
    const prefixPart = event.prefix ? ` ${event.prefix}` : '';
    const line = `${event.timestamp}${prefixPart} ${event.type} ${JSON.stringify(event.data)}\n`;
    writeSync(this.fd, line);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

/**
 * Build the nesting prefix string from the context's nesting path and current step ID.
 *
 * Examples:
 * - nestingPath: [], step 'validate' -> '[validate]'
 * - nestingPath: [{stepId: "task-loop", iteration: 0}], step 'implement' -> '[task-loop:0, implement]'
 * - nestingPath: [{stepId: "task-loop", iteration: 0}, {stepId: "verify", subWorkflowName: "verify-task"}], step 'check'
 *   -> '[task-loop:0, verify, sub:verify-task, check]'
 */
export function buildPrefix(
  nestingPath: NestingSegment[],
  stepId: string,
): string {
  const tokens: string[] = [];

  for (const segment of nestingPath) {
    if (segment.iteration === undefined) {
      tokens.push(segment.stepId);
    } else {
      tokens.push(`${segment.stepId}:${segment.iteration}`);
    }

    if (segment.subWorkflowName) {
      tokens.push(`sub:${segment.subWorkflowName}`);
    }
  }

  tokens.push(stepId);
  return `[${tokens.join(', ')}]`;
}

/**
 * Encode a directory path for use in the log directory name.
 * Replaces /, ., and _ with -.
 */
function encodePath(dirPath: string): string {
  return dirPath.replace(/[/._]/g, '-');
}

/**
 * Sanitize a workflow name for safe use in file paths.
 * Replaces path-unsafe characters (/, \, ..) with dashes.
 */
function sanitizeWorkflowName(name: string): string {
  return name.replace(/\.\./g, '-').replace(/[/\\]/g, '-');
}

/**
 * Create an AuditLogger instance for a workflow run.
 * Log path: ~/.baton/projects/{encoded-cwd}/logs/{workflow-name}-{timestamp}.log
 */
export function createAuditLogger(
  workflowName: string,
  cwd: string = process.cwd(),
): AuditLogger {
  const home = process.env.HOME || require('node:os').homedir();
  const encoded = encodePath(cwd);
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const safeName = sanitizeWorkflowName(workflowName);
  const logDir = join(home, '.baton', 'projects', encoded, 'logs');
  const logFile = join(logDir, `${safeName}-${timestamp}.log`);
  return new AuditLogger(logFile);
}
