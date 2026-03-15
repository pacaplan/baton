import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Step, Workflow } from './schema.ts';
import { WorkflowSchema } from './schema.ts';

export interface LoadWorkflowOptions {
  /** When true, allows session: inherit at the top level */
  isSubWorkflow?: boolean;
}

export function loadWorkflow(
  filePath: string,
  options?: LoadWorkflowOptions,
): Workflow {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw);
  const workflow = WorkflowSchema.parse(parsed);
  validateWorkflowConstraints(workflow, {
    isSubWorkflow: options?.isSubWorkflow ?? false,
  });
  return workflow;
}

/**
 * Validate workflow-level constraints that cannot be expressed
 * in the Zod schema alone (positional rules like skip_if on first step).
 */
export interface ValidationOptions {
  isSubWorkflow?: boolean;
}

export function validateWorkflowConstraints(
  workflow: Workflow,
  options?: ValidationOptions,
): void {
  const isTopLevel = !options?.isSubWorkflow;
  validateStepList(workflow.steps, { insideLoop: false, isTopLevel });
}

function validateStepList(
  steps: Step[],
  ctx: { insideLoop: boolean; isTopLevel: boolean },
): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;

    validateSingleStep(step, i, ctx);

    if (step.steps) {
      const childCtx = {
        insideLoop: ctx.insideLoop || !!step.loop,
        isTopLevel: false,
      };
      validateStepList(step.steps, childCtx);
    }
  }
}

function validateSingleStep(
  step: Step,
  index: number,
  ctx: { insideLoop: boolean; isTopLevel: boolean },
): void {
  if (step.skip_if && index === 0) {
    throw new Error(
      `Step "${step.id}": skip_if cannot be used on the first step in scope`,
    );
  }

  if (step.break_if && !ctx.insideLoop) {
    throw new Error(
      `Step "${step.id}": break_if is only allowed inside a loop body`,
    );
  }

  if (step.session === 'inherit' && ctx.isTopLevel) {
    throw new Error(
      `Step "${step.id}": session "inherit" is not allowed in a top-level workflow`,
    );
  }
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
    // biome-ignore lint/style/noNonNullAssertion: index is guaranteed by first-pass logic
    result = result.replace(`\0FILE_SENTINEL_${i}\0`, fileContents[i]!);
  }

  return result;
}
