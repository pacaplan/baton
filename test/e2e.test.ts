import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURES = join(import.meta.dir, 'fixtures');
const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');

async function runBaton(
  fixture: string,
  stateDir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ['bun', ENTRY, 'run', join(FIXTURES, fixture)],
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

describe('E2E: shell executor', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      'baton-e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('captures stdout and interpolates in subsequent step', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-capture.yaml',
      testDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('hello-captured');
    expect(stdout).toContain('got hello-captured');
  });

  it('continues after failure with continue_on_failure', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-continue-on-failure.yaml',
      testDir,
    );

    // The workflow should exit 0 since it reaches the end
    expect(exitCode).toBe(0);
    expect(stdout).toContain('continued');
  });

  it('skips step when previous succeeded and skip_if=previous_success', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-skip-if-success.yaml',
      testDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('SHOULD-NOT-APPEAR');
    expect(stdout).toContain('final');
  });

  it('runs step when previous failed with skip_if=previous_success', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-skip-if-failure.yaml',
      testDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('EXECUTED-AFTER-FAILURE');
  });

  it('deletes state file on successful completion', async () => {
    await runBaton('e2e-success-deletes-state.yaml', testDir);

    const stateFile = join(testDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(false);
  });

  it('preserves state file on failure', async () => {
    const { exitCode } = await runBaton(
      'e2e-failure-preserves-state.yaml',
      testDir,
    );

    // Workflow should fail
    expect(exitCode).not.toBe(0);
    const stateFile = join(testDir, 'baton-state.json');
    expect(existsSync(stateFile)).toBe(true);

    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(state.currentStep.stepId).toBe('failing-step');
  });
});
