import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resumeWorkflow } from '../src/commands/resume.ts';
import { computeWorkflowHash } from '../src/state.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

describe('Resume into sub-workflow', () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      'baton-resume-subwf-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('resumes from nested sub-workflow state', async () => {
    // Create parent workflow that invokes a sub-workflow
    const parentWorkflow = join(testDir, 'parent.yaml');
    const parentContent = `
name: parent-wf
steps:
  - id: step-before
    mode: shell
    command: echo "before"
  - id: invoke-sub
    workflow: child.yaml
  - id: step-after
    mode: shell
    command: echo "after"
`;
    writeFileSync(parentWorkflow, parentContent);

    // Create child workflow
    const childWorkflow = join(testDir, 'child.yaml');
    const childContent = `
name: child-wf
steps:
  - id: child-step-1
    mode: shell
    command: echo "child-1"
  - id: child-step-2
    mode: shell
    command: echo "child-2"
`;
    writeFileSync(childWorkflow, childContent);

    // State file records position inside the sub-workflow at child-step-2
    const stateFile = join(testDir, 'baton-state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        workflowFile: parentWorkflow,
        workflowName: 'parent-wf',
        currentStep: {
          stepId: 'invoke-sub',
          sessionIds: {},
          capturedVariables: {},
          child: {
            stepId: 'child-step-2',
            sessionIds: {},
            capturedVariables: {},
            child: null,
          },
        },
        params: {},
        workflowHash: computeWorkflowHash(parentContent),
      }),
    );

    await resumeWorkflow(stateFile);

    // Verify: child-step-1 was skipped (only child-step-2 and step-after ran)
    // Spawn calls: child-step-2 ("echo child-2") then step-after ("echo after")
    const commands = spawnSpy.mock.calls.map(
      (call) => (call[0] as string[])[2],
    );
    expect(commands).not.toContain('echo "child-1"');
    expect(commands).toContain('echo "child-2"');
    expect(commands).toContain('echo "after"');
  });

  it('fails with descriptive error when sub-workflow step no longer exists', async () => {
    const parentWorkflow = join(testDir, 'parent.yaml');
    const parentContent = `
name: parent-wf
steps:
  - id: step-before
    mode: shell
    command: echo "before"
  - id: invoke-sub
    workflow: child.yaml
  - id: step-after
    mode: shell
    command: echo "after"
`;
    writeFileSync(parentWorkflow, parentContent);

    // Child workflow has changed — no longer has 'old-step'
    const childWorkflow = join(testDir, 'child.yaml');
    writeFileSync(
      childWorkflow,
      `
name: child-wf
steps:
  - id: new-step
    mode: shell
    command: echo "new"
`,
    );

    const stateFile = join(testDir, 'baton-state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        workflowFile: parentWorkflow,
        workflowName: 'parent-wf',
        currentStep: {
          stepId: 'invoke-sub',
          sessionIds: {},
          capturedVariables: {},
          child: {
            stepId: 'old-step',
            sessionIds: {},
            capturedVariables: {},
            child: null,
          },
        },
        params: {},
        workflowHash: computeWorkflowHash(parentContent),
      }),
    );

    await expect(resumeWorkflow(stateFile)).rejects.toThrow(
      /old-step.*not found|not found.*old-step/,
    );
  });
});

function makeMockProc(exitCode = 0) {
  return {
    pid: 12345,
    exited: Promise.resolve(exitCode),
    kill: () => {},
    stdin: null,
    stdout: null,
    stderr: null,
  };
}
