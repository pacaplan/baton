import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { type Workflow, WorkflowSchema } from './schema.ts';

export function loadWorkflow(filePath: string): Workflow {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);
  return WorkflowSchema.parse(parsed);
}

export function interpolateParams(
  template: string,
  params: Record<string, string>,
): string {
  // First pass: resolve {{file:paramName}} → read file content with instructions
  let result = template.replace(
    /\{\{file:(\w+)\}\}/g,
    (_match, key: string) => {
      const filePath = params[key];
      if (!filePath) return '';
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        return [
          `The following file was provided as context for this step. Use it to inform your work:`,
          '',
          `<file path="${filePath}">`,
          content,
          `</file>`,
        ].join('\n');
      } catch {
        throw new Error(
          `Cannot read file for parameter {{file:${key}}}: ${filePath}`,
        );
      }
    },
  );

  // Second pass: resolve {{paramName}} → param value
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing parameter: {{${key}}}`);
    }
    return value;
  });

  return result;
}
