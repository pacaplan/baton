import { createOpenSpecEngine } from './engines/openspec.ts';
import type { Workflow } from './schema.ts';

export interface Engine {
  getStateDir?(params: Record<string, string>): string;
  validateWorkflow?(
    workflow: Workflow,
    params: Record<string, string>,
    workflowFile?: string,
  ): void;
  /** Returns true when initial validation was inconclusive (e.g. resource not yet created). */
  needsDeferredValidation?(): boolean;
  enrichPrompt?(
    stepId: string,
    params: Record<string, string>,
    options?: { sessionStrategy?: string },
  ): string | undefined;
  validateStep?(stepId: string, params: Record<string, string>): boolean;
}

export type EngineConstructor = (config: Record<string, unknown>) => Engine;

const engineRegistry: Record<string, EngineConstructor> = {
  openspec: createOpenSpecEngine,
};

export function registerEngine(type: string, ctor: EngineConstructor): void {
  engineRegistry[type] = ctor;
}

export function createEngine(engineConfig: Record<string, unknown>): Engine {
  const { type, ...rest } = engineConfig;
  if (typeof type !== 'string') {
    throw new Error('Engine config must have a "type" field');
  }
  const ctor = engineRegistry[type];
  if (!ctor) {
    throw new Error(`Unknown engine type: "${type}"`);
  }
  return ctor(rest);
}
