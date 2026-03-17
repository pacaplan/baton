import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Workflow } from '../../src/schema.ts';

let spawnSyncSpy: ReturnType<typeof spyOn>;
let whichSpy: ReturnType<typeof spyOn>;

function mockSyncResult(
  stdout: string,
  exitCode = 0,
  stderr = '',
): ReturnType<typeof Bun.spawnSync> {
  const encoder = new TextEncoder();
  return {
    exitCode,
    stdout: Buffer.from(encoder.encode(stdout)),
    stderr: Buffer.from(encoder.encode(stderr)),
    success: exitCode === 0,
    pid: 99999,
    resourceUsage: undefined,
    signalCode: null,
  } as unknown as ReturnType<typeof Bun.spawnSync>;
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    name: 'test-wf',
    agent: 'claude-code',
    params: [],
    steps: [
      { id: 'proposal', mode: 'headless', prompt: 'Do it', session: 'new' },
      { id: 'specs', mode: 'headless', prompt: 'Spec it', session: 'new' },
      { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
      { id: 'tasks', mode: 'headless', prompt: 'Plan it', session: 'new' },
      { id: 'review', mode: 'headless', prompt: 'Review it', session: 'new' },
    ],
    ...overrides,
  };
}

const STATUS_OUTPUT = JSON.stringify({
  changeName: 'my-change',
  changeDir: '/absolute/path/to/openspec/changes/my-change',
  artifacts: [
    { id: 'proposal', status: 'done' },
    { id: 'specs', status: 'ready' },
    { id: 'design', status: 'blocked' },
    { id: 'tasks', status: 'blocked' },
    { id: 'review', status: 'blocked' },
  ],
});

const INSTRUCTIONS_OUTPUT = JSON.stringify({
  artifactId: 'proposal',
  schemaName: 'flokay',
  instruction: 'Write a proposal document',
  outputPath: 'artifacts/proposal.md',
  template: '# Proposal\n\nWrite your proposal here.',
  dependencies: [
    { path: 'some/dep.md', description: 'A dependency file' },
    { path: 'another/dep.txt', description: 'Another dependency' },
  ],
  changeDir: '/absolute/path/to/openspec/changes/my-change',
});

describe('OpenSpecEngine', () => {
  beforeEach(() => {
    spawnSyncSpy = spyOn(Bun, 'spawnSync');
    whichSpy = spyOn(Bun, 'which');
  });

  afterEach(() => {
    spawnSyncSpy.mockRestore();
    whichSpy.mockRestore();
  });

  describe('construction', () => {
    it('initializes successfully with valid config and available CLI', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });
      expect(engine).toBeDefined();
      expect(engine.getStateDir).toBeDefined();
      expect(engine.validateWorkflow).toBeDefined();
      expect(engine.enrichPrompt).toBeDefined();
      expect(engine.validateStep).toBeDefined();
    });

    it('throws when change_param is missing from config', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      expect(() => createOpenSpecEngine({})).toThrow('change_param');
    });

    it('throws when openspec CLI is not available', () => {
      whichSpy.mockReturnValue(null);

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      expect(() => createOpenSpecEngine({ change_param: 'change_name' })).toThrow(
        'openspec CLI not found',
      );
    });
  });

  describe('getStateDir', () => {
    it('returns the change directory path', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });
      const dir = engine.getStateDir({ change_name: 'my-change' });
      expect(dir).toBe('openspec/changes/my-change/');
    });

    it('throws when the change param is missing from params', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });
      expect(() => engine.getStateDir({})).toThrow('change_name');
    });
  });

  describe('validateWorkflow', () => {
    it('passes when all artifact IDs have matching step IDs', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation(() => mockSyncResult(STATUS_OUTPUT, 0));

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });
      const wf = makeWorkflow();

      expect(() => engine.validateWorkflow(wf, { change_name: 'my-change' })).not.toThrow();
    });

    it('fails when an artifact ID has no matching step', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation(() => mockSyncResult(STATUS_OUTPUT, 0));

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      const wf = makeWorkflow({
        steps: [
          { id: 'specs', mode: 'headless', prompt: 'Spec it', session: 'new' },
          { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
          { id: 'tasks', mode: 'headless', prompt: 'Plan it', session: 'new' },
          { id: 'review', mode: 'headless', prompt: 'Review it', session: 'new' },
        ],
      });

      expect(() => engine.validateWorkflow(wf, { change_name: 'my-change' })).toThrow('proposal');
    });

    it('skips validation when the change does not exist yet', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation(() =>
        mockSyncResult('', 1, "Change 'new-change' not found."),
      );

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });
      const wf = makeWorkflow();

      expect(() => engine.validateWorkflow(wf, { change_name: 'new-change' })).not.toThrow();
    });

    it('passes when workflow has extra steps without matching artifacts', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation(() => mockSyncResult(STATUS_OUTPUT, 0));

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      const wf = makeWorkflow({
        steps: [
          { id: 'create', mode: 'shell', command: 'echo create', session: 'new' },
          { id: 'proposal', mode: 'headless', prompt: 'Propose it', session: 'new' },
          { id: 'specs', mode: 'headless', prompt: 'Spec it', session: 'new' },
          { id: 'design', mode: 'headless', prompt: 'Design it', session: 'new' },
          { id: 'tasks', mode: 'headless', prompt: 'Plan it', session: 'new' },
          { id: 'review', mode: 'headless', prompt: 'Review it', session: 'new' },
          { id: 'implement', mode: 'headless', prompt: 'Build it', session: 'new' },
        ],
      });

      expect(() => engine.validateWorkflow(wf, { change_name: 'my-change' })).not.toThrow();
    });

  });

  describe('enrichPrompt', () => {
    it('returns markdown enrichment with output path, template path, and dependencies', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation((args: string[]) => {
        if (args[0] === 'openspec' && args[1] === 'status') {
          return mockSyncResult(STATUS_OUTPUT, 0);
        }
        if (args[0] === 'openspec' && args[1] === 'instructions') {
          return mockSyncResult(INSTRUCTIONS_OUTPUT, 0);
        }
        return mockSyncResult('', 0);
      });

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      // Init the artifact set via validateWorkflow
      engine.validateWorkflow(makeWorkflow(), { change_name: 'my-change' });

      const result = engine.enrichPrompt('proposal', { change_name: 'my-change' });

      expect(result).toBeDefined();
      expect(result).toContain('**Output path:**');
      expect(result).toContain(
        '/absolute/path/to/openspec/changes/my-change/artifacts/proposal.md',
      );
      expect(result).toContain('**Template:**');
      expect(result).toContain('schemas/flokay/templates/proposal.md');
      // Template content should NOT be inlined
      expect(result).not.toContain('# Proposal\n\nWrite your proposal here.');
      // Dependencies should be present for new sessions
      expect(result).toContain('**Dependencies:**');
      expect(result).toContain('/absolute/path/to/openspec/changes/my-change/some/dep.md');
      expect(result).toContain('/absolute/path/to/openspec/changes/my-change/another/dep.txt');
      expect(result).toContain('A dependency file');
      expect(result).toContain('Another dependency');
      // The instruction field should be included
      expect(result).toContain('Write a proposal document');
      // Should include read instruction
      expect(result).toContain('Read the template file');
      // Should NOT contain XML tags
      expect(result).not.toContain('<artifact_context>');
    });

    it('skips dependencies for resumed sessions', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation((args: string[]) => {
        if (args[0] === 'openspec' && args[1] === 'status') {
          return mockSyncResult(STATUS_OUTPUT, 0);
        }
        if (args[0] === 'openspec' && args[1] === 'instructions') {
          return mockSyncResult(INSTRUCTIONS_OUTPUT, 0);
        }
        return mockSyncResult('', 0);
      });

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      engine.validateWorkflow(makeWorkflow(), { change_name: 'my-change' });

      const result = engine.enrichPrompt('proposal', { change_name: 'my-change' }, {
        sessionStrategy: 'resume',
      });

      expect(result).toBeDefined();
      // Output path and template should still be present
      expect(result).toContain('**Output path:**');
      expect(result).toContain('**Template:**');
      // Dependencies should be omitted
      expect(result).not.toContain('**Dependencies:**');
      expect(result).not.toContain('some/dep.md');
      // Instruction should still be present
      expect(result).toContain('Write a proposal document');
    });

    it('returns undefined for non-artifact step IDs', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation(() => mockSyncResult(STATUS_OUTPUT, 0));

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      engine.validateWorkflow(makeWorkflow(), { change_name: 'my-change' });

      const result = engine.enrichPrompt('implement', { change_name: 'my-change' });
      expect(result).toBeUndefined();
    });

    it('throws when openspec instructions CLI call fails', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation((args: string[]) => {
        if (args[0] === 'openspec' && args[1] === 'status') {
          return mockSyncResult(STATUS_OUTPUT, 0);
        }
        if (args[0] === 'openspec' && args[1] === 'instructions') {
          return mockSyncResult('', 1, 'CLI error: change not found');
        }
        return mockSyncResult('', 0);
      });

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      engine.validateWorkflow(makeWorkflow(), { change_name: 'my-change' });

      expect(() => engine.enrichPrompt('proposal', { change_name: 'my-change' })).toThrow(
        'CLI error: change not found',
      );
    });
  });

  describe('validateStep', () => {
    it('returns true when artifact status is done', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation(() => mockSyncResult(STATUS_OUTPUT, 0));

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      engine.validateWorkflow(makeWorkflow(), { change_name: 'my-change' });

      // 'proposal' has status 'done' in STATUS_OUTPUT
      const result = engine.validateStep('proposal', { change_name: 'my-change' });
      expect(result).toBe(true);
    });

    it('returns false when artifact status is not done', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation(() => mockSyncResult(STATUS_OUTPUT, 0));

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      engine.validateWorkflow(makeWorkflow(), { change_name: 'my-change' });

      // 'specs' has status 'ready' in STATUS_OUTPUT
      const result = engine.validateStep('specs', { change_name: 'my-change' });
      expect(result).toBe(false);
    });

    it('returns true for non-artifact step IDs', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      spawnSyncSpy.mockImplementation(() => mockSyncResult(STATUS_OUTPUT, 0));

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      engine.validateWorkflow(makeWorkflow(), { change_name: 'my-change' });

      const result = engine.validateStep('implement', { change_name: 'my-change' });
      expect(result).toBe(true);
    });

    it('throws when openspec status CLI call fails', () => {
      whichSpy.mockReturnValue('/usr/local/bin/openspec');
      let statusCallCount = 0;
      spawnSyncSpy.mockImplementation((args: string[]) => {
        if (args[0] === 'openspec' && args[1] === 'status') {
          statusCallCount++;
          // First call succeeds (for validateWorkflow), second fails
          if (statusCallCount === 1) {
            return mockSyncResult(STATUS_OUTPUT, 0);
          }
          return mockSyncResult('', 1, 'status check failed');
        }
        return mockSyncResult('', 0);
      });

      const { createOpenSpecEngine } = require('../../src/engines/openspec.ts');
      const engine = createOpenSpecEngine({ change_param: 'change_name' });

      engine.validateWorkflow(makeWorkflow(), { change_name: 'my-change' });

      expect(() => engine.validateStep('proposal', { change_name: 'my-change' })).toThrow(
        'status check failed',
      );
    });
  });
});
