import type { Workflow } from './schema.ts';

export interface Engine {
  getStateDir?(params: Record<string, string>): string;
  validateWorkflow?(workflow: Workflow): void;
  enrichPrompt?(
    stepId: string,
    params: Record<string, string>,
  ): string | undefined;
  validateStep?(stepId: string, params: Record<string, string>): boolean;
}

export type EngineConstructor = (config: Record<string, unknown>) => Engine;

const engineRegistry: Record<string, EngineConstructor> = {};

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
