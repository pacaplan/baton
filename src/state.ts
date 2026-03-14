import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const STATE_FILE_NAME = 'baton-state.json';

export interface NestedStepState {
  stepId: string;
  sessionIds: Record<string, string>;
  capturedVariables: Record<string, string>;
  child: NestedStepState | null;
}

export interface RunState {
  workflowFile: string;
  workflowName: string;
  currentStep: string | NestedStepState;
  params: Record<string, string>;
  workflowHash: string;
  /** @deprecated Use NestedStepState.sessionIds instead for new state files */
  sessionIds?: Record<string, string>;
}

export function writeState(state: RunState, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, STATE_FILE_NAME);
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function readState(filePath: string): RunState {
  if (!existsSync(filePath)) {
    throw new Error(`State file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    throw new Error(`Invalid state file (malformed JSON): ${filePath}`);
  }
}

export function deleteState(dir: string): void {
  const filePath = join(dir, STATE_FILE_NAME);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}

export function getStateFilePath(dir: string): string {
  return join(dir, STATE_FILE_NAME);
}

export function computeWorkflowHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
