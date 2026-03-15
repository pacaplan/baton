import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURES = join(import.meta.dir, 'fixtures');
const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');

async function runBaton(
  fixture: string,
  stateDir: string,
  args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ['bun', ENTRY, 'run', join(FIXTURES, fixture), ...args],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        BATON_STATE_DIR: stateDir,
      },
      cwd: stateDir,
    },
  );

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr };
}

describe('E2E: sub-workflow executor', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      'baton-e2e-subwf-' +
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

  it('parent invokes sub-workflow with params and sub-workflow echoes param value', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-sub-workflow-params.yaml',
      testDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('param:hello-from-parent');
    expect(stdout).toContain('parent-after-sub');
  });

  it('captured variables in sub-workflow do not leak to parent', async () => {
    const { exitCode, stdout, stderr } = await runBaton(
      'e2e-sub-workflow-no-leak.yaml',
      testDir,
    );

    // Parent tries to reference {{sub_capture}} which was captured in sub-workflow
    // This should fail because captured vars don't leak
    expect(exitCode).not.toBe(0);
    const combined = stdout + stderr;
    expect(combined).toContain('sub_capture');
  });

  it('missing sub-workflow file produces a descriptive error', async () => {
    const { exitCode, stdout, stderr } = await runBaton(
      'e2e-sub-workflow-missing.yaml',
      testDir,
    );

    expect(exitCode).not.toBe(0);
    const combined = stdout + stderr;
    expect(combined).toContain('nonexistent-workflow.yaml');
  });

  it('sub-workflow does not inherit parent params implicitly', async () => {
    const { exitCode, stdout, stderr } = await runBaton(
      'e2e-sub-workflow-no-inherit-params.yaml',
      testDir,
    );

    // Sub-workflow tries to use {{parent_only}} which wasn't passed
    expect(exitCode).not.toBe(0);
    const combined = stdout + stderr;
    expect(combined).toContain('parent_only');
  });
});
