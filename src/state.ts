import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE_NAME = 'baton-state.json';

export interface RunState {
  workflowFile: string;
  workflowName: string;
  currentStep: string;
  sessionIds: Record<string, string>;
  params: Record<string, string>;
  workflowHash: string;
}

export function writeState(state: RunState, dir: string): void {
  const filePath = join(dir, STATE_FILE_NAME);
  writeFileSync(filePath, JSON.stringify(state, null, 2));
}

export function readState(filePath: string): RunState {
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as RunState;
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
