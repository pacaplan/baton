import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resumeWorkflow } from '../src/commands/resume.ts';

function makeMockProc(exitCode = 0) {
  return {
    pid: 12345,
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
    stdin: null,
    stdout: null,
    stderr: null,
  };
}

describe('resumeWorkflow', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let testDir: string;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => makeMockProc(0) as never);
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    testDir = join(tmpdir(), 'baton-resume-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('resumes from state file with valid workflow', async () => {
    // Create a workflow file
    const workflowFile = join(testDir, 'workflow.yaml');
    const workflowContent = `
name: test-wf
steps:
  - id: step1
    mode: shell
    command: echo first
  - id: step2
    mode: shell
    command: echo second
`;
    writeFileSync(workflowFile, workflowContent);

    // Create a state file
    const stateFile = join(testDir, 'baton-state.json');
    const { computeWorkflowHash } = await import('../src/state.ts');
    const hash = computeWorkflowHash(workflowContent);
    writeFileSync(stateFile, JSON.stringify({
      workflowFile,
      workflowName: 'test-wf',
      currentStep: 'step2',
      sessionIds: { step1: 'sess-abc' },
      params: {},
      workflowHash: hash,
    }));

    await resumeWorkflow(stateFile);

    // Should only run step2 (resumed from step2)
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[2]).toBe('echo second');
  });

  it('warns when workflow file has changed', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const workflowFile = join(testDir, 'workflow.yaml');
    writeFileSync(workflowFile, `
name: test-wf
steps:
  - id: step1
    mode: shell
    command: echo first
`);

    const stateFile = join(testDir, 'baton-state.json');
    writeFileSync(stateFile, JSON.stringify({
      workflowFile,
      workflowName: 'test-wf',
      currentStep: 'step1',
      sessionIds: {},
      params: {},
      workflowHash: 'old-hash-that-no-longer-matches',
    }));

    await resumeWorkflow(stateFile);

    // Should warn about changed workflow
    const warnCalls = warnSpy.mock.calls.map((c) => c[0]);
    expect(warnCalls.some((msg: string) => msg.includes('changed'))).toBe(true);
  });

  it('fails when currentStep no longer exists in workflow', async () => {
    const workflowFile = join(testDir, 'workflow.yaml');
    writeFileSync(workflowFile, `
name: test-wf
steps:
  - id: step1
    mode: shell
    command: echo first
`);

    const stateFile = join(testDir, 'baton-state.json');
    writeFileSync(stateFile, JSON.stringify({
      workflowFile,
      workflowName: 'test-wf',
      currentStep: 'nonexistent-step',
      sessionIds: {},
      params: {},
      workflowHash: 'whatever',
    }));

    await expect(resumeWorkflow(stateFile)).rejects.toThrow(
      'Step "nonexistent-step" not found',
    );
  });

  it('passes persisted sessionIds and params to runWorkflow', async () => {
    const workflowFile = join(testDir, 'workflow.yaml');
    const workflowContent = `
name: test-wf
params:
  - name: target
steps:
  - id: step1
    mode: shell
    command: echo {{target}}
  - id: step2
    mode: shell
    command: echo {{target}} done
`;
    writeFileSync(workflowFile, workflowContent);

    const stateFile = join(testDir, 'baton-state.json');
    const { computeWorkflowHash } = await import('../src/state.ts');
    writeFileSync(stateFile, JSON.stringify({
      workflowFile,
      workflowName: 'test-wf',
      currentStep: 'step2',
      sessionIds: { step1: 'sess-abc' },
      params: { target: 'prod' },
      workflowHash: computeWorkflowHash(workflowContent),
    }));

    await resumeWorkflow(stateFile);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[2]).toBe('echo prod done');
  });

  it('throws for missing state file', async () => {
    await expect(
      resumeWorkflow('/nonexistent/baton-state.json'),
    ).rejects.toThrow();
  });
});
