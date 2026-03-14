import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readState, writeState, deleteState, computeWorkflowHash, type RunState } from '../src/state.ts';

const TEST_DIR = join(tmpdir(), 'baton-state-test-' + Date.now());
const STATE_FILE_NAME = 'baton-state.json';

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    workflowFile: '/path/to/workflow.yaml',
    workflowName: 'test-wf',
    currentStep: 'step1',
    sessionIds: {},
    params: {},
    workflowHash: 'abc123',
    ...overrides,
  };
}

describe('state module', () => {
  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('writes and reads state file', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const state = makeState({ currentStep: 'design', params: { name: 'foo' } });
    writeState(state, TEST_DIR);

    const filePath = join(TEST_DIR, STATE_FILE_NAME);
    expect(existsSync(filePath)).toBe(true);

    const loaded = readState(filePath);
    expect(loaded.currentStep).toBe('design');
    expect(loaded.params).toEqual({ name: 'foo' });
    expect(loaded.workflowName).toBe('test-wf');
    expect(loaded.workflowFile).toBe('/path/to/workflow.yaml');
    expect(loaded.workflowHash).toBe('abc123');
  });

  it('deletes state file', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const state = makeState();
    writeState(state, TEST_DIR);

    const filePath = join(TEST_DIR, STATE_FILE_NAME);
    expect(existsSync(filePath)).toBe(true);

    deleteState(TEST_DIR);
    expect(existsSync(filePath)).toBe(false);
  });

  it('deleteState is a no-op if file does not exist', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Should not throw
    deleteState(TEST_DIR);
  });

  it('readState throws for missing file', () => {
    expect(() => readState('/nonexistent/path/baton-state.json')).toThrow();
  });

  it('writes state with sessionIds', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const state = makeState({ sessionIds: { step1: 'sess-abc', step2: 'sess-def' } });
    writeState(state, TEST_DIR);

    const loaded = readState(join(TEST_DIR, STATE_FILE_NAME));
    expect(loaded.sessionIds).toEqual({ step1: 'sess-abc', step2: 'sess-def' });
  });
});

describe('computeWorkflowHash', () => {
  it('returns a consistent hash for the same content', () => {
    const hash1 = computeWorkflowHash('hello world');
    const hash2 = computeWorkflowHash('hello world');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different content', () => {
    const hash1 = computeWorkflowHash('hello world');
    const hash2 = computeWorkflowHash('goodbye world');
    expect(hash1).not.toBe(hash2);
  });
});
