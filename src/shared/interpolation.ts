import type { ExecutionContext } from '../context.ts';

/**
 * Interpolate {{variable}} placeholders in a template string.
 * Merges context params and captured variables, with captured
 * variables taking precedence when names collide.
 */
export function interpolate(
  template: string,
  context: ExecutionContext,
): string {
  const merged = { ...context.params, ...context.capturedVariables };
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = merged[key];
    if (value === undefined) {
      throw new Error(`Undefined variable: {{${key}}}`);
    }
    return value;
  });
}
