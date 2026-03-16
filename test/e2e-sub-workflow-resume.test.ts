import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { computeWorkflowHash } from '../src/state.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');

async function runBaton(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', ENTRY, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr };
}

describe('E2E: sub-workflow resume', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      'baton-e2e-subwf-resume-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('records child state in baton-state.json after sub-workflow step fails', async () => {
    // Create a parent workflow with a sub-workflow whose second step fails
    const childContent = `
name: child-wf
steps:
  - id: child-ok
    mode: shell
    command: echo "child-ok"
  - id: child-fail
    mode: shell
    command: exit 1
  - id: child-never
    mode: shell
    command: echo "never"
`;
    const parentContent = `
name: parent-wf
steps:
  - id: run-sub
    workflow: child.yaml
  - id: after-sub
    mode: shell
    command: echo "after"
`;
    writeFileSync(join(testDir, 'child.yaml'), childContent);
    writeFileSync(join(testDir, 'parent.yaml'), parentContent);

    const { exitCode } = await runBaton(
      ['run', join(testDir, 'parent.yaml')],
      testDir,
    );
    expect(exitCode).not.toBe(0);

    // State file should record position inside the sub-workflow
    const stateFile = join(testDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(true);

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(state.currentStep.stepId).toBe('run-sub');
    expect(state.currentStep.child).not.toBeNull();
    expect(state.currentStep.child.stepId).toBe('child-fail');
  });

  it('resumes inside sub-workflow skipping completed steps', async () => {
    // Create workflows: child has 3 steps, all succeed
    const childContent = `
name: child-wf
steps:
  - id: child-step1
    mode: shell
    command: echo "child-step1-ran"
  - id: child-step2
    mode: shell
    command: echo "child-step2-ran"
  - id: child-step3
    mode: shell
    command: echo "child-step3-ran"
`;
    const parentContent = `
name: parent-wf
steps:
  - id: run-sub
    workflow: child.yaml
  - id: after-sub
    mode: shell
    command: echo "after-sub-ran"
`;
    writeFileSync(join(testDir, 'child.yaml'), childContent);
    const parentPath = join(testDir, 'parent.yaml');
    writeFileSync(parentPath, parentContent);

    // Manually create a state file that says we're inside the sub-workflow
    // at child-step2 (meaning child-step1 already completed)
    const stateFile = join(testDir, 'baton-state.json');
    writeFileSync(
      stateFile,
      JSON.stringify({
        workflowFile: parentPath,
        workflowName: 'parent-wf',
        currentStep: {
          stepId: 'run-sub',
          sessionIds: {},
          capturedVariables: {},
          child: {
            stepId: 'child-step2',
            sessionIds: {},
            capturedVariables: {},
            child: null,
          },
        },
        params: {},
        workflowHash: computeWorkflowHash(parentContent),
      }),
    );

    const { exitCode, stdout } = await runBaton(
      ['resume', stateFile],
      testDir,
    );

    expect(exitCode).toBe(0);
    // child-step1 should NOT have run (was skipped on resume)
    expect(stdout).not.toContain('child-step1-ran');
    // child-step2 and child-step3 should have run
    expect(stdout).toContain('child-step2-ran');
    expect(stdout).toContain('child-step3-ran');
    // parent step after sub-workflow should also run
    expect(stdout).toContain('after-sub-ran');
  });
});
