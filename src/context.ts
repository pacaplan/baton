import type { Engine } from './engine.ts';

export interface NestingSegment {
  stepId: string;
  iteration?: number;
  loopVar?: Record<string, string>;
}

export interface ExecutionContext {
  params: Record<string, string>;
  sessionIds: Record<string, string>;
  capturedVariables: Record<string, string>;
  lastStepOutcome: 'success' | 'failed' | null;

  nestingPath: NestingSegment[];
  parentContext: ExecutionContext | null;

  workflowFile: string;
  engine: Engine | null;
}

export interface RootContextOptions {
  params: Record<string, string>;
  workflowFile: string;
  engine: Engine | null;
  sessionIds?: Record<string, string>;
  capturedVariables?: Record<string, string>;
}

export function createRootContext(
  options: RootContextOptions,
): ExecutionContext {
  return {
    params: { ...options.params },
    sessionIds: options.sessionIds ? { ...options.sessionIds } : {},
    capturedVariables: options.capturedVariables
      ? { ...options.capturedVariables }
      : {},
    lastStepOutcome: null,
    nestingPath: [],
    parentContext: null,
    workflowFile: options.workflowFile,
    engine: options.engine,
  };
}

export interface LoopIterationOptions {
  stepId: string;
  iteration: number;
  loopVar?: Record<string, string>;
}

export function createLoopIterationContext(
  parent: ExecutionContext,
  options: LoopIterationOptions,
): ExecutionContext {
  const segment: NestingSegment = {
    stepId: options.stepId,
    iteration: options.iteration,
    loopVar: options.loopVar,
  };

  return {
    params: { ...parent.params, ...options.loopVar },
    sessionIds: {},
    capturedVariables: {},
    lastStepOutcome: null,
    nestingPath: [...parent.nestingPath, segment],
    parentContext: parent,
    workflowFile: parent.workflowFile,
    engine: parent.engine,
  };
}

export interface SubWorkflowContextOptions {
  stepId: string;
  params: Record<string, string>;
  workflowFile: string;
}

export function createSubWorkflowContext(
  parent: ExecutionContext,
  options: SubWorkflowContextOptions,
): ExecutionContext {
  const segment: NestingSegment = {
    stepId: options.stepId,
  };

  return {
    params: { ...options.params },
    sessionIds: {},
    capturedVariables: {},
    lastStepOutcome: null,
    nestingPath: [...parent.nestingPath, segment],
    parentContext: parent,
    workflowFile: options.workflowFile,
    engine: parent.engine,
  };
}
