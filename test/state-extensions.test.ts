import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  type NestedStepState,
  type RunState,
  readState,
  writeState,
} from '../src/state.ts';

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    'baton-state-ext-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('nested state format', () => {
  let testDir: string;

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('writes state with nested currentStep object', () => {
    testDir = makeTmpDir();
    const state: RunState = {
      workflowFile: 'test.yaml',
      workflowName: 'test-wf',
      currentStep: {
        stepId: 'step1',
        sessionIds: { step1: 'sess-1' },
        capturedVariables: { output: 'hello' },
        child: null,
      },
      params: { x: '1' },
      workflowHash: 'abc123',
    };
    writeState(state, testDir);

    const raw = JSON.parse(
      readFileSync(join(testDir, 'baton-state.json'), 'utf-8'),
    );
    expect(raw.currentStep.stepId).toBe('step1');
    expect(raw.currentStep.sessionIds).toEqual({ step1: 'sess-1' });
    expect(raw.currentStep.capturedVariables).toEqual({ output: 'hello' });
    expect(raw.currentStep.child).toBeNull();
  });

  it('reads nested currentStep state', () => {
    testDir = makeTmpDir();
    const state: RunState = {
      workflowFile: 'test.yaml',
      workflowName: 'test-wf',
      currentStep: {
        stepId: 'implement',
        sessionIds: {},
        capturedVariables: { gauntlet_output: 'passed' },
        child: null,
      },
      params: {},
      workflowHash: 'def456',
    };
    writeState(state, testDir);

    const loaded = readState(join(testDir, 'baton-state.json'));
    const cs = loaded.currentStep as NestedStepState;
    expect(cs.stepId).toBe('implement');
    expect(cs.capturedVariables).toEqual({ gauntlet_output: 'passed' });
  });

  it('reads legacy flat currentStep (backwards compatibility)', () => {
    testDir = makeTmpDir();
    // Write a flat state file manually (old format)
    const flatState = {
      workflowFile: 'old.yaml',
      workflowName: 'old-wf',
      currentStep: 'step2',
      sessionIds: { step1: 'sess-1' },
      params: { x: '1' },
      workflowHash: 'old-hash',
    };
    const filePath = join(testDir, 'baton-state.json');
    require('node:fs').writeFileSync(filePath, JSON.stringify(flatState));

    const loaded = readState(filePath);
    // When currentStep is a flat string, it should be read as-is
    expect(typeof loaded.currentStep).toBe('string');
    expect(loaded.currentStep).toBe('step2');
  });

  it('writes state with nested child', () => {
    testDir = makeTmpDir();
    const state: RunState = {
      workflowFile: 'test.yaml',
      workflowName: 'test-wf',
      currentStep: {
        stepId: 'loop1',
        sessionIds: {},
        capturedVariables: {},
        child: {
          stepId: 'inner-step',
          sessionIds: { 'inner-step': 'sess-inner' },
          capturedVariables: { result: 'ok' },
          child: null,
        },
      },
      params: {},
      workflowHash: 'xyz789',
    };
    writeState(state, testDir);

    const loaded = readState(join(testDir, 'baton-state.json'));
    const cs = loaded.currentStep as NestedStepState;
    expect(cs.stepId).toBe('loop1');
    expect(cs.child).not.toBeNull();
    expect(cs.child?.stepId).toBe('inner-step');
    expect(cs.child?.capturedVariables).toEqual({ result: 'ok' });
  });
});
