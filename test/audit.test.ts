import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPrefix, AuditLogger, createAuditLogger } from '../src/audit.ts';
import type { AuditEvent } from '../src/audit.ts';
import type { NestingSegment } from '../src/context.ts';

describe('buildPrefix', () => {
  it('returns prefix for top-level step', () => {
    const nestingPath: NestingSegment[] = [];
    const result = buildPrefix(nestingPath, 'validate');
    expect(result).toBe('[validate]');
  });

  it('returns prefix for step inside a loop', () => {
    const nestingPath: NestingSegment[] = [
      { stepId: 'task-loop', iteration: 2 },
    ];
    const result = buildPrefix(nestingPath, 'implement');
    expect(result).toBe('[task-loop:2, implement]');
  });

  it('returns prefix for step inside a loop at iteration 0', () => {
    const nestingPath: NestingSegment[] = [
      { stepId: 'task-loop', iteration: 0 },
    ];
    const result = buildPrefix(nestingPath, 'implement');
    expect(result).toBe('[task-loop:0, implement]');
  });

  it('returns prefix for step inside a sub-workflow inside a loop', () => {
    const nestingPath: NestingSegment[] = [
      { stepId: 'task-loop', iteration: 0 },
      { stepId: 'verify', subWorkflowName: 'verify-task' },
    ];
    const result = buildPrefix(nestingPath, 'check');
    expect(result).toBe('[task-loop:0, verify, sub:verify-task, check]');
  });

  it('returns prefix for step inside a sub-workflow without loop', () => {
    const nestingPath: NestingSegment[] = [
      { stepId: 'deploy', subWorkflowName: 'deploy-sub' },
    ];
    const result = buildPrefix(nestingPath, 'run');
    expect(result).toBe('[deploy, sub:deploy-sub, run]');
  });

  it('returns prefix with plain nesting segment (no loop, no sub-workflow)', () => {
    const nestingPath: NestingSegment[] = [
      { stepId: 'parent' },
    ];
    const result = buildPrefix(nestingPath, 'child');
    expect(result).toBe('[parent, child]');
  });
});

describe('AuditLogger', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      'baton-audit-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('writes events to file in correct format', () => {
    const logPath = join(testDir, 'test.log');
    const logger = new AuditLogger(logPath);

    const event: AuditEvent = {
      timestamp: '2026-03-15T18:30:00Z',
      prefix: '[validate]',
      type: 'step_start',
      data: { command: 'npm test' },
    };

    logger.emit(event);
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const line = content.trim();
    expect(line).toBe('2026-03-15T18:30:00Z [validate] step_start {"command":"npm test"}');
  });

  it('writes run-level events without prefix brackets', () => {
    const logPath = join(testDir, 'test.log');
    const logger = new AuditLogger(logPath);

    const event: AuditEvent = {
      timestamp: '2026-03-15T18:30:00Z',
      prefix: '',
      type: 'run_start',
      data: { workflow: 'deploy' },
    };

    logger.emit(event);
    logger.close();

    const content = readFileSync(logPath, 'utf-8');
    const line = content.trim();
    expect(line).toBe('2026-03-15T18:30:00Z run_start {"workflow":"deploy"}');
  });

  it('writes multiple events as separate lines', () => {
    const logPath = join(testDir, 'test.log');
    const logger = new AuditLogger(logPath);

    logger.emit({
      timestamp: '2026-03-15T18:30:00Z',
      prefix: '',
      type: 'run_start',
      data: {},
    });
    logger.emit({
      timestamp: '2026-03-15T18:30:01Z',
      prefix: '[step1]',
      type: 'step_start',
      data: {},
    });
    logger.close();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('flushes each write immediately (sync I/O)', () => {
    const logPath = join(testDir, 'test.log');
    const logger = new AuditLogger(logPath);

    logger.emit({
      timestamp: '2026-03-15T18:30:00Z',
      prefix: '',
      type: 'run_start',
      data: {},
    });

    // Read before close — should still be present due to sync writes
    const content = readFileSync(logPath, 'utf-8');
    expect(content.trim()).toContain('run_start');

    logger.close();
  });

  it('creates parent directories if they do not exist', () => {
    const logPath = join(testDir, 'nested', 'deep', 'test.log');
    const logger = new AuditLogger(logPath);

    logger.emit({
      timestamp: '2026-03-15T18:30:00Z',
      prefix: '',
      type: 'run_start',
      data: {},
    });
    logger.close();

    expect(existsSync(logPath)).toBe(true);
  });

  it('supports all event types without error', () => {
    const logPath = join(testDir, 'test.log');
    const logger = new AuditLogger(logPath);

    const types = [
      'run_start', 'run_end', 'step_start', 'step_end',
      'iteration_start', 'iteration_end',
      'sub_workflow_start', 'sub_workflow_end', 'error',
    ] as const;

    for (const type of types) {
      logger.emit({
        timestamp: '2026-03-15T18:30:00Z',
        prefix: '',
        type,
        data: {},
      });
    }
    logger.close();

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(types.length);
  });
});

describe('createAuditLogger', () => {
  let originalHome: string | undefined;
  let testHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    testHome = join(
      tmpdir(),
      'baton-audit-home-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    mkdirSync(testHome, { recursive: true });
    process.env.HOME = testHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (testHome && existsSync(testHome)) {
      rmSync(testHome, { recursive: true });
    }
  });

  it('creates log file in correct directory', () => {
    const logger = createAuditLogger('deploy', '/Users/foo/my_project');
    logger.emit({
      timestamp: '2026-03-15T18:30:00Z',
      prefix: '',
      type: 'run_start',
      data: {},
    });
    logger.close();

    const logDir = join(testHome, '.baton', 'projects', '-Users-foo-my-project', 'logs');
    expect(existsSync(logDir)).toBe(true);
  });

  it('encodes path correctly — replaces /, ., and _ with -', () => {
    const logger = createAuditLogger('deploy', '/Users/foo/my_project.v2');
    logger.emit({
      timestamp: '2026-03-15T18:30:00Z',
      prefix: '',
      type: 'run_start',
      data: {},
    });
    logger.close();

    const logDir = join(testHome, '.baton', 'projects', '-Users-foo-my-project-v2', 'logs');
    expect(existsSync(logDir)).toBe(true);
  });

  it('names log file with workflow name and timestamp', () => {
    const logger = createAuditLogger('deploy', '/tmp/proj');
    logger.emit({
      timestamp: '2026-03-15T18:30:00Z',
      prefix: '',
      type: 'run_start',
      data: {},
    });
    logger.close();

    const logDir = join(testHome, '.baton', 'projects', '-tmp-proj', 'logs');
    const files = require('node:fs').readdirSync(logDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^deploy-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.*\.log$/);
  });

  it('creates log directory when it does not exist', () => {
    const logger = createAuditLogger('test-wf', '/some/new/path');
    logger.close();

    const logDir = join(testHome, '.baton', 'projects', '-some-new-path', 'logs');
    expect(existsSync(logDir)).toBe(true);
  });
});
