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
  // First pass: replace {{file:paramName}} with sentinel tokens, collecting file contents
  const fileContents: string[] = [];
  let result = template.replace(
    /\{\{file:(\w+)\}\}/g,
    (_match, key: string) => {
      const filePath = params[key];
      if (filePath === undefined) {
        throw new Error(`Missing parameter: {{file:${key}}}`);
      }
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        const block = [
          `The following file was provided as context for this step. Use it to inform your work:`,
          '',
          `<file path="${filePath}">`,
          content,
          `</file>`,
        ].join('\n');
        const index = fileContents.length;
        fileContents.push(block);
        return `\0FILE_SENTINEL_${index}\0`;
      } catch {
        throw new Error(
          `Cannot read file for parameter {{file:${key}}}: ${filePath}`,
        );
      }
    },
  );

  // Second pass: resolve {{paramName}} → param value (file content is protected by sentinels)
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing parameter: {{${key}}}`);
    }
    return value;
  });

  // Third pass: replace sentinels with actual file contents
  for (let i = 0; i < fileContents.length; i++) {
    result = result.replace(`\0FILE_SENTINEL_${i}\0`, fileContents[i]!);
  }

  return result;
}
