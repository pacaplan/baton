import { z } from 'zod';

export const StepMode = z.enum(['interactive', 'headless', 'shell']);
export type StepMode = z.infer<typeof StepMode>;

export const SessionStrategy = z.enum(['new', 'resume']);
export type SessionStrategy = z.infer<typeof SessionStrategy>;

export const StepSchema = z
  .object({
    id: z.string(),
    prompt: z.string().optional(),
    command: z.string().optional(),
    mode: StepMode,
    session: SessionStrategy.default('new'),
  })
  .refine(
    (step) => {
      if (step.mode === 'shell') return !!step.command;
      return !!step.prompt;
    },
    { message: 'Shell steps require "command", agent steps require "prompt"' },
  );

export type Step = z.infer<typeof StepSchema>;

export const ParamSchema = z.object({
  name: z.string(),
  required: z.boolean().default(true),
  default: z.string().optional(),
});

export type Param = z.infer<typeof ParamSchema>;

export const WorkflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  agent: z.string().default('claude-code'),
  params: z.array(ParamSchema).default([]),
  steps: z.array(StepSchema).min(1),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
