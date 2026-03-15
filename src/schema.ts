import { z } from 'zod';

export const StepMode = z.enum(['interactive', 'headless', 'shell']);
export type StepMode = z.infer<typeof StepMode>;

export const SessionStrategy = z.enum(['new', 'resume', 'inherit']);
export type SessionStrategy = z.infer<typeof SessionStrategy>;

export const LoopSchema = z
  .object({
    max: z.number().int().positive().optional(),
    over: z.string().optional(),
    as: z.string().optional(),
  })
  .superRefine((loop, ctx) => {
    const hasMax = loop.max !== undefined;
    const hasOver = loop.over !== undefined;
    const hasAs = loop.as !== undefined;

    if (hasMax && (hasOver || hasAs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Loop must use either "max" or both "over" and "as", not both',
      });
    }

    if (!hasMax && hasOver !== hasAs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Loop requires both "over" and "as"',
      });
    }

    if (!(hasMax || hasOver || hasAs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Loop requires "max" or both "over" and "as"',
      });
    }
  });

export type Loop = z.infer<typeof LoopSchema>;

const BaseStepSchema = z.object({
  id: z.string(),
  prompt: z.string().optional(),
  command: z.string().optional(),
  mode: StepMode.optional(),
  session: SessionStrategy.default('new'),
  capture: z.string().optional(),
  continue_on_failure: z.boolean().optional(),
  skip_if: z.enum(['previous_success']).optional(),
  break_if: z.enum(['success', 'failure']).optional(),
  model: z.string().optional(),
  workflow: z.string().optional(),
  loop: LoopSchema.optional(),
  params: z.record(z.string(), z.string()).optional(),
});

// Use z.lazy for recursive steps field
export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  BaseStepSchema.extend({
    steps: z.array(StepSchema).optional(),
  })
    .refine(
      (step) => {
        return hasExactlyOneStepType(step);
      },
      {
        message:
          'Step must have exactly one of: command, prompt/mode, loop+steps, workflow, or steps (group)',
      },
    )
    .refine(
      (step) => {
        if (step.mode === 'shell') return !!step.command;
        if (step.mode === 'interactive' || step.mode === 'headless') {
          return !!step.prompt;
        }
        return true;
      },
      {
        message: 'Shell steps require "command", agent steps require "prompt"',
      },
    )
    .refine(
      (step) => {
        if (step.capture && step.mode !== 'shell' && !step.command)
          return false;
        return true;
      },
      { message: '"capture" is only allowed on shell steps' },
    )
    .refine(
      (step) => {
        if (step.model && step.mode === 'shell') return false;
        if (step.model && !step.mode && !step.prompt) return false;
        return true;
      },
      { message: '"model" is only allowed on agent steps' },
    )
    .refine(
      (step) => {
        if (step.loop && !(Array.isArray(step.steps) && step.steps.length > 0))
          return false;
        return true;
      },
      { message: '"loop" requires a non-empty "steps" array' },
    )
    .refine(
      (step) => {
        if (step.params && !step.workflow) return false;
        return true;
      },
      { message: '"params" is only allowed on sub-workflow steps' },
    ),
);

function hasExactlyOneStepType(step: {
  command?: string;
  prompt?: string;
  mode?: string;
  workflow?: string;
  loop?: unknown;
  steps?: unknown[];
}): boolean {
  const isShell = !!step.command;
  const isAgent =
    !!step.prompt || step.mode === 'interactive' || step.mode === 'headless';
  const isLoop = !!step.loop && Array.isArray(step.steps);
  const isSubWorkflow = !!step.workflow;
  const isGroup =
    !step.loop && Array.isArray(step.steps) && step.steps.length > 0;

  const count = [isShell, isAgent, isLoop, isSubWorkflow, isGroup].filter(
    Boolean,
  ).length;
  return count === 1;
}

export interface Step {
  id: string;
  prompt?: string;
  command?: string;
  mode?: StepMode;
  session: SessionStrategy;
  capture?: string;
  continue_on_failure?: boolean;
  skip_if?: 'previous_success';
  break_if?: 'success' | 'failure';
  model?: string;
  workflow?: string;
  loop?: Loop;
  params?: Record<string, string>;
  steps?: Step[];
}

export const ParamSchema = z.object({
  name: z.string(),
  required: z.boolean().default(true),
  default: z.string().optional(),
});

export type Param = z.infer<typeof ParamSchema>;

export const EngineSchema = z
  .object({
    type: z.string(),
  })
  .catchall(z.unknown());

export type EngineConfig = z.infer<typeof EngineSchema>;

export const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  agent: z.string().default('claude-code'),
  params: z.array(ParamSchema).default([]),
  steps: z.array(StepSchema).min(1),
  engine: EngineSchema.optional(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
