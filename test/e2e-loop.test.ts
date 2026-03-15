import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
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

describe('E2E: loop executor', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      'baton-e2e-loop-' +
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

  it('for-each loop iterates over matched files', async () => {
    // Create temp files to match
    const subDir = join(testDir, 'tasks');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'a.task.md'), 'a');
    writeFileSync(join(subDir, 'b.task.md'), 'b');
    writeFileSync(join(subDir, 'c.task.md'), 'c');

    const globPattern = join(subDir, '*.task.md');

    const { exitCode, stdout } = await runBaton(
      'e2e-foreach-loop.yaml',
      testDir,
      [globPattern],
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('file:');
    // Filter for actual echo output lines (not the "command:" log lines)
    const fileLines = stdout
      .split('\n')
      .filter((l) => l.startsWith('file:'));
    expect(fileLines.length).toBe(3);
  });

  it('counted loop with break_if exits early', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-counted-loop-break.yaml',
      testDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('after-loop-reached');
  });

  it('counted loop exhaustion fails the workflow', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-counted-loop-exhaust.yaml',
      testDir,
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain('SHOULD-NOT-APPEAR');
  });

  it('glob with zero matches skips the loop body', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-glob-zero-matches.yaml',
      testDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain('SHOULD-NOT-APPEAR');
    expect(stdout).toContain('skipped-empty-loop');
  });

  it('glob pattern with param interpolation resolves before expansion', async () => {
    const subDir = join(testDir, 'mychange');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'x.task.md'), 'x');
    writeFileSync(join(subDir, 'y.task.md'), 'y');

    const { exitCode, stdout } = await runBaton(
      'e2e-glob-interpolation.yaml',
      testDir,
      [testDir, 'mychange'],
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('interpolation-done');
    const foundLines = stdout
      .split('\n')
      .filter((l) => l.startsWith('found:'));
    expect(foundLines.length).toBe(2);
  });

  it('bare group executes children sequentially', async () => {
    const { exitCode, stdout } = await runBaton(
      'e2e-bare-group.yaml',
      testDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('group-child-1');
    expect(stdout).toContain('group-child-2');
    expect(stdout).toContain('after-group');
  });
});
