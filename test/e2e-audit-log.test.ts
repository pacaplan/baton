import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const FIXTURES = join(import.meta.dir, 'fixtures');
const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');

async function runBaton(
  fixture: string,
  stateDir: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ['bun', ENTRY, 'run', join(FIXTURES, fixture)],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        BATON_STATE_DIR: stateDir,
        ...env,
      },
      cwd: stateDir,
    },
  );

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr };
}

function findLogFiles(homeDir: string): string[] {
  const projectsDir = join(homeDir, '.baton', 'projects');
  if (!existsSync(projectsDir)) return [];
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.log')) {
        files.push(full);
      }
    }
  }
  walk(projectsDir);
  return files;
}

function parseLogEvents(logPath: string): Array<{ timestamp: string; prefix: string; type: string; data: Record<string, unknown> }> {
  const content = readFileSync(logPath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(line => {
    const jsonStart = line.indexOf('{');
    const data = jsonStart >= 0 ? JSON.parse(line.substring(jsonStart)) : {};
    const beforeJson = line.substring(0, jsonStart).trim();
    const parts = beforeJson.split(/\s+/);
    const timestamp = parts[0] || '';
    const type = parts[parts.length - 1] || '';
    // Prefix is everything between timestamp and type
    const prefix = parts.length > 2 ? parts.slice(1, -1).join(' ') : '';
    return { timestamp, prefix, type, data };
  });
}

describe('E2E: audit log', () => {
  let testDir: string;
  let testHome: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      'baton-e2e-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
    testHome = join(
      tmpdir(),
      'baton-e2e-audit-home-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    if (testHome && existsSync(testHome)) {
      rmSync(testHome, { recursive: true });
    }
  });

  it('creates a log file with correct event sequence', async () => {
    const { exitCode } = await runBaton('e2e-audit-log.yaml', testDir, { HOME: testHome });
    expect(exitCode).toBe(0);

    const logFiles = findLogFiles(testHome);
    expect(logFiles.length).toBe(1);

    const events = parseLogEvents(logFiles[0]!);
    const types = events.map(e => e.type);

    // Event sequence: run_start, step_start, step_end, step_start, step_end, run_end
    expect(types[0]).toBe('run_start');
    expect(types[types.length - 1]).toBe('run_end');

    const stepStarts = events.filter(e => e.type === 'step_start');
    const stepEnds = events.filter(e => e.type === 'step_end');
    expect(stepStarts.length).toBe(2);
    expect(stepEnds.length).toBe(2);
  });

  it('log file has correct format: timestamp prefix type json', async () => {
    const { exitCode } = await runBaton('e2e-audit-log.yaml', testDir, { HOME: testHome });
    expect(exitCode).toBe(0);

    const logFiles = findLogFiles(testHome);
    const content = readFileSync(logFiles[0]!, 'utf-8').trim();
    const lines = content.split('\n');

    // Each line should start with ISO timestamp
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Should contain JSON at the end
      const jsonStart = line.indexOf('{');
      expect(jsonStart).toBeGreaterThan(0);
      // JSON should be parseable
      expect(() => JSON.parse(line.substring(jsonStart))).not.toThrow();
    }
  });

  it('captures stderr content in audit log step_end', async () => {
    const { exitCode } = await runBaton('e2e-audit-stderr.yaml', testDir, { HOME: testHome });
    expect(exitCode).toBe(0);

    const logFiles = findLogFiles(testHome);
    const events = parseLogEvents(logFiles[0]!);

    const stepEnd = events.find(e => e.type === 'step_end');
    expect(stepEnd).toBeTruthy();
    expect(stepEnd!.data.stderr).toContain('stderr content');
  });

  it('log file name follows workflow-name-timestamp pattern', async () => {
    await runBaton('e2e-audit-log.yaml', testDir, { HOME: testHome });

    const logFiles = findLogFiles(testHome);
    expect(logFiles.length).toBe(1);
    const fileName = logFiles[0]!.split('/').pop()!;
    expect(fileName).toMatch(/^audit-test-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.*\.log$/);
  });

  it('run_start includes workflow metadata', async () => {
    await runBaton('e2e-audit-log.yaml', testDir, { HOME: testHome });

    const logFiles = findLogFiles(testHome);
    const events = parseLogEvents(logFiles[0]!);
    const runStart = events.find(e => e.type === 'run_start');

    expect(runStart).toBeTruthy();
    expect(runStart!.data.workflow_name).toBe('audit-test');
    expect(runStart!.data.params).toEqual({});
  });

  it('run_end includes success outcome', async () => {
    await runBaton('e2e-audit-log.yaml', testDir, { HOME: testHome });

    const logFiles = findLogFiles(testHome);
    const events = parseLogEvents(logFiles[0]!);
    const runEnd = events.find(e => e.type === 'run_end');

    expect(runEnd).toBeTruthy();
    expect(runEnd!.data.outcome).toBe('success');
    expect(typeof runEnd!.data.duration_ms).toBe('number');
  });

  it('step entries have correct nesting prefix', async () => {
    await runBaton('e2e-audit-log.yaml', testDir, { HOME: testHome });

    const logFiles = findLogFiles(testHome);
    const events = parseLogEvents(logFiles[0]!);

    const stepStarts = events.filter(e => e.type === 'step_start');
    expect(stepStarts[0]!.prefix).toBe('[greet]');
    expect(stepStarts[1]!.prefix).toBe('[warn]');
  });

  it('stderr is teed to terminal output', async () => {
    const { stderr } = await runBaton('e2e-audit-stderr.yaml', testDir, { HOME: testHome });
    expect(stderr).toContain('stderr content');
  });

  it('loop workflow emits iteration_start/iteration_end events', async () => {
    const { exitCode } = await runBaton('e2e-counted-loop-break.yaml', testDir, { HOME: testHome });
    expect(exitCode).toBe(0);

    const logFiles = findLogFiles(testHome);
    expect(logFiles.length).toBe(1);

    const events = parseLogEvents(logFiles[0]!);
    const types = events.map(e => e.type);

    // Should have run_start, loop step_start, iteration events, loop step_end, after-loop step_start/end, run_end
    expect(types[0]).toBe('run_start');
    expect(types[types.length - 1]).toBe('run_end');

    // Should have iteration events
    const iterStarts = events.filter(e => e.type === 'iteration_start');
    const iterEnds = events.filter(e => e.type === 'iteration_end');
    expect(iterStarts.length).toBeGreaterThan(0);
    expect(iterEnds.length).toBe(iterStarts.length);

    // Loop step_start should include loop_type
    const loopStart = events.find(e => e.type === 'step_start' && e.data.loop_type);
    expect(loopStart).toBeTruthy();
    expect(loopStart!.data.loop_type).toBe('counted');
    expect(loopStart!.data.max).toBe(5);

    // Loop step_end should include iterations_completed
    const loopEnd = events.find(e => e.type === 'step_end' && e.data.iterations_completed !== undefined);
    expect(loopEnd).toBeTruthy();
    expect(loopEnd!.data.break_triggered).toBe(true);

    // Iteration prefixes should include step:index
    expect(iterStarts[0]!.prefix).toBe('[retry-loop:0]');
  });

  it('sub-workflow emits sub_workflow_start/sub_workflow_end events', async () => {
    const { exitCode } = await runBaton('e2e-sub-workflow-params.yaml', testDir, { HOME: testHome });
    expect(exitCode).toBe(0);

    const logFiles = findLogFiles(testHome);
    expect(logFiles.length).toBe(1);

    const events = parseLogEvents(logFiles[0]!);
    const types = events.map(e => e.type);

    expect(types[0]).toBe('run_start');
    expect(types[types.length - 1]).toBe('run_end');

    // Should have sub_workflow_start and sub_workflow_end
    const subStarts = events.filter(e => e.type === 'sub_workflow_start');
    const subEnds = events.filter(e => e.type === 'sub_workflow_end');
    expect(subStarts.length).toBe(1);
    expect(subEnds.length).toBe(1);

    // sub_workflow_start should have context
    expect(subStarts[0]!.data.context).toBeDefined();

    // sub_workflow_end should have outcome
    expect(subEnds[0]!.data.outcome).toBe('success');

    // Sub-workflow step_start should include workflow_path
    const subStepStart = events.find(e => e.type === 'step_start' && e.data.workflow_path);
    expect(subStepStart).toBeTruthy();
    expect(subStepStart!.data.params).toEqual({ msg: 'hello-from-parent' });

    // Child step events should include the sub-workflow nesting prefix
    const childStepStart = events.find(e =>
      e.type === 'step_start' && e.data.command !== undefined && e.prefix.includes('sub:')
    );
    expect(childStepStart).toBeTruthy();
    expect(childStepStart!.prefix).toContain('invoke-sub');
    expect(childStepStart!.prefix).toContain('sub:sub-workflow-with-params');
  });
});
