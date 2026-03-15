import { buildPrefix } from '../audit.ts';
import {
  createLoopIterationContext,
  type ExecutionContext,
} from '../context.ts';
import type { Step } from '../schema.ts';
import { evaluateBreakIf } from '../shared/flow-control.ts';
import { interpolate } from '../shared/interpolation.ts';
import { executeAgentStep } from './agent.ts';
import { executeShellStep } from './shell.ts';

export interface LoopResult {
  outcome: 'success' | 'failed' | 'exhausted';
  lastIteration: number;
}

export interface LoopExecuteOptions {
  resumeFromIteration?: number;
}

/**
 * Execute a step with a loop configuration.
 * Supports counted loops (max) and for-each loops (over/as).
 */
export async function executeLoopStep(
  step: Step,
  context: ExecutionContext,
  options: LoopExecuteOptions = {},
): Promise<LoopResult> {
  if (!(step.loop && step.steps)) {
    return { outcome: 'failed', lastIteration: -1 };
  }

  const { loop, steps } = step;

  if (loop.over && loop.as) {
    return executeForEachLoop(
      step.id,
      loop.over,
      loop.as,
      steps,
      context,
      options,
    );
  }

  if (loop.max !== undefined) {
    return executeCountedLoop(step.id, loop.max, steps, context, options);
  }

  return { outcome: 'failed', lastIteration: -1 };
}

async function executeCountedLoop(
  stepId: string,
  max: number,
  steps: Step[],
  context: ExecutionContext,
  options: LoopExecuteOptions,
): Promise<LoopResult> {
  const prefix = buildPrefix(context.nestingPath, stepId);
  const startTime = Date.now();

  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: {
      loop_type: 'counted',
      max,
      context: {
        params: { ...context.params },
        capturedVariables: { ...context.capturedVariables },
      },
    },
  });

  const startIteration = options.resumeFromIteration ?? 0;
  let lastIteration = startIteration;
  let iterationsCompleted = 0;

  for (let i = startIteration; i < max; i++) {
    lastIteration = i;
    const iterCtx = createLoopIterationContext(context, {
      stepId,
      iteration: i,
    });

    const iterResult = await executeIterationWithAudit(steps, iterCtx);
    iterationsCompleted++;

    if (iterResult.failed) {
      emitLoopStepEnd(
        context,
        prefix,
        startTime,
        iterationsCompleted,
        false,
        'failed',
      );
      return { outcome: 'failed', lastIteration: i };
    }
    if (iterResult.breakTriggered) {
      emitLoopStepEnd(
        context,
        prefix,
        startTime,
        iterationsCompleted,
        true,
        'success',
      );
      return { outcome: 'success', lastIteration: i };
    }
  }

  emitLoopStepEnd(
    context,
    prefix,
    startTime,
    iterationsCompleted,
    false,
    'exhausted',
  );
  return { outcome: 'exhausted', lastIteration };
}

async function executeForEachLoop(
  stepId: string,
  overPattern: string,
  asVar: string,
  steps: Step[],
  context: ExecutionContext,
  options: LoopExecuteOptions,
): Promise<LoopResult> {
  const pattern = interpolate(overPattern, context);
  const matches = await expandGlob(pattern);

  const prefix = buildPrefix(context.nestingPath, stepId);
  const startTime = Date.now();

  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_start',
    data: {
      loop_type: 'for-each',
      glob_pattern: pattern,
      resolved_matches: [...matches],
      context: {
        params: { ...context.params },
        capturedVariables: { ...context.capturedVariables },
      },
    },
  });

  if (matches.length === 0) {
    emitLoopStepEnd(context, prefix, startTime, 0, false, 'success');
    return { outcome: 'success', lastIteration: -1 };
  }

  const startIteration = options.resumeFromIteration ?? 0;
  let lastIteration = startIteration;
  let iterationsCompleted = 0;

  for (let i = startIteration; i < matches.length; i++) {
    lastIteration = i;
    const matchValue = matches[i];
    if (matchValue === undefined) continue;

    const loopVar = { [asVar]: matchValue };
    const iterCtx = createLoopIterationContext(context, {
      stepId,
      iteration: i,
      loopVar,
    });

    const iterResult = await executeIterationWithAudit(steps, iterCtx);
    iterationsCompleted++;

    if (iterResult.failed) {
      emitLoopStepEnd(
        context,
        prefix,
        startTime,
        iterationsCompleted,
        false,
        'failed',
      );
      return { outcome: 'failed', lastIteration: i };
    }
    if (iterResult.breakTriggered) {
      emitLoopStepEnd(
        context,
        prefix,
        startTime,
        iterationsCompleted,
        true,
        'success',
      );
      return { outcome: 'success', lastIteration: i };
    }
  }

  emitLoopStepEnd(
    context,
    prefix,
    startTime,
    iterationsCompleted,
    false,
    'success',
  );
  return { outcome: 'success', lastIteration };
}

function emitLoopStepEnd(
  context: ExecutionContext,
  prefix: string,
  startTime: number,
  iterationsCompleted: number,
  breakTriggered: boolean,
  outcome: string,
): void {
  context.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'step_end',
    data: {
      iterations_completed: iterationsCompleted,
      break_triggered: breakTriggered,
      outcome,
      duration_ms: Date.now() - startTime,
    },
  });
}

interface IterationResult {
  breakTriggered: boolean;
  failed: boolean;
}

async function executeIterationWithAudit(
  steps: Step[],
  iterCtx: ExecutionContext,
): Promise<IterationResult> {
  const nestingPath = iterCtx.nestingPath;
  const lastSegment = nestingPath[nestingPath.length - 1];
  if (!lastSegment || lastSegment.iteration === undefined) {
    return executeIterationBody(steps, iterCtx);
  }

  const prefix = buildPrefix(
    nestingPath.slice(0, -1),
    `${lastSegment.stepId}:${lastSegment.iteration}`,
  );

  const iterStartTime = Date.now();
  const iteration = lastSegment.iteration;
  const loopVar = lastSegment.loopVar;

  const startData: Record<string, unknown> = {
    iteration,
    context: {
      params: { ...iterCtx.params },
      capturedVariables: { ...iterCtx.capturedVariables },
    },
  };
  if (loopVar) {
    startData.loop_var = { ...loopVar };
  }

  iterCtx.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'iteration_start',
    data: startData,
  });

  const result = await executeIterationBody(steps, iterCtx);

  const outcome = result.failed ? 'failed' : 'success';

  iterCtx.auditLogger?.emit({
    timestamp: new Date().toISOString(),
    prefix,
    type: 'iteration_end',
    data: {
      iteration,
      outcome,
      duration_ms: Date.now() - iterStartTime,
    },
  });

  return result;
}

async function executeIterationBody(
  steps: Step[],
  iterCtx: ExecutionContext,
): Promise<IterationResult> {
  for (const childStep of steps) {
    const outcome = await dispatchChildStep(childStep, iterCtx);

    if (evaluateBreakIf(childStep, outcome)) {
      return { breakTriggered: true, failed: false };
    }

    iterCtx.lastStepOutcome = outcome;

    if (outcome === 'failed' && !childStep.continue_on_failure) {
      return { breakTriggered: false, failed: true };
    }
  }
  return { breakTriggered: false, failed: false };
}

async function dispatchChildStep(
  step: Step,
  context: ExecutionContext,
): Promise<'success' | 'failed'> {
  if (step.steps && step.loop) {
    const result = await executeLoopStep(step, context);
    if (result.outcome === 'exhausted') return 'failed';
    return result.outcome === 'success' ? 'success' : 'failed';
  }

  if (step.steps && !step.loop) {
    return executeGroupStep(step.steps, context);
  }

  if (step.command) {
    return executeShellStep(step, context);
  }

  if (step.prompt || step.mode === 'interactive' || step.mode === 'headless') {
    const outcome = await executeAgentStep(step, context);
    return outcome === 'aborted' ? 'failed' : outcome;
  }

  return 'failed';
}

async function executeGroupStep(
  steps: Step[],
  context: ExecutionContext,
): Promise<'success' | 'failed'> {
  for (const childStep of steps) {
    const outcome = await dispatchChildStep(childStep, context);
    context.lastStepOutcome = outcome;

    if (outcome === 'failed' && !childStep.continue_on_failure) {
      return 'failed';
    }
  }
  return 'success';
}

async function expandGlob(pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];
  for await (const match of glob.scan({ dot: false })) {
    matches.push(match);
  }
  matches.sort();
  return matches;
}
