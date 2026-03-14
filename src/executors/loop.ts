import {
  createLoopIterationContext,
  type ExecutionContext,
} from '../context.ts';
import type { Step } from '../schema.ts';
import { evaluateBreakIf } from '../shared/flow-control.ts';
import { interpolate } from '../shared/interpolation.ts';
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
  const startIteration = options.resumeFromIteration ?? 0;
  let lastIteration = startIteration;

  for (let i = startIteration; i < max; i++) {
    lastIteration = i;
    const iterCtx = createLoopIterationContext(context, {
      stepId,
      iteration: i,
    });

    const iterResult = await executeIterationBody(steps, iterCtx);
    if (iterResult.failed) {
      return { outcome: 'failed', lastIteration: i };
    }
    if (iterResult.breakTriggered) {
      return { outcome: 'success', lastIteration: i };
    }
  }

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

  if (matches.length === 0) {
    return { outcome: 'success', lastIteration: -1 };
  }

  const startIteration = options.resumeFromIteration ?? 0;
  let lastIteration = startIteration;

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

    const iterResult = await executeIterationBody(steps, iterCtx);
    if (iterResult.failed) {
      return { outcome: 'failed', lastIteration: i };
    }
    if (iterResult.breakTriggered) {
      return { outcome: 'success', lastIteration: i };
    }
  }

  return { outcome: 'success', lastIteration };
}

interface IterationResult {
  breakTriggered: boolean;
  failed: boolean;
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
