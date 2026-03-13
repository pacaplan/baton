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
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing parameter: {{${key}}}`);
    }
    return value;
  });
}
