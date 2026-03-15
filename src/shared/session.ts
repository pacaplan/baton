import type { ExecutionContext } from '../context.ts';

/**
 * Resolve `session: inherit` — walk the parentContext chain
 * until crossing a sub-workflow boundary (different workflowFile),
 * then return that context's most recent session ID.
 */
export function resolveInheritSession(context: ExecutionContext): string {
  if (!context.parentContext) {
    throw new Error('session "inherit" is not allowed in a top-level workflow');
  }

  // Walk up to find a context with a different workflowFile
  let current: ExecutionContext | null = context.parentContext;
  while (current) {
    if (current.workflowFile !== context.workflowFile) {
      const sessionId = getMostRecentSessionId(current.sessionIds);
      if (sessionId) return sessionId;
      throw new Error('session "inherit" failed: no parent session exists');
    }
    current = current.parentContext;
  }

  throw new Error('session "inherit" failed: no parent session exists');
}

/**
 * Resolve `session: resume` — return the most recent session ID
 * from the current context's sessionIds. Does NOT cross
 * sub-workflow boundaries.
 */
export function resolveResumeSession(context: ExecutionContext): string {
  const sessionId = getMostRecentSessionId(context.sessionIds);
  if (!sessionId) {
    throw new Error(
      'session "resume" failed: no prior session in current workflow',
    );
  }
  return sessionId;
}

function getMostRecentSessionId(
  sessionIds: Record<string, string>,
): string | undefined {
  const keys = Object.keys(sessionIds);
  if (keys.length === 0) return undefined;
  const lastKey = keys[keys.length - 1];
  return lastKey ? sessionIds[lastKey] : undefined;
}
