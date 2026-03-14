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
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing parameter: {{${key}}}`);
    }
    return value;
  });
}
