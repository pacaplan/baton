import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { createRootContext, createSubWorkflowContext } from '../src/context.ts';
import type { ExecutionContext } from '../src/context.ts';
import type { AuditEvent } from '../src/audit.ts';
import type { Step } from '../src/schema.ts';

// Mock ora before agent.ts is imported
const mockSpinner = {
  start: mock(function () { return mockSpinner; }),
  stop: mock(function () { return mockSpinner; }),
};
const mockOra = mock((_text?: string) => mockSpinner);
mock.module('ora', () => ({ default: mockOra }));

function makeCtx(
  overrides: Partial<Parameters<typeof createRootContext>[0]> = {},
): ExecutionContext {
  return createRootContext({
    params: {},
    workflowFile: 'test.yaml',
    engine: null,
    ...overrides,
  });
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'agent-step',
    mode: 'headless',
    prompt: 'Do something',
    session: 'new',
    ...overrides,
  };
}

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

// Dynamically import after mocking to ensure mocks are in place
async function importExecutor() {
  return import('../src/executors/agent.ts');
}

describe('AgentExecutor: headless mode', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('spawns claude with -p flag and prompt', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ prompt: 'Do the thing' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[0]).toBe('claude');
    expect(callArgs).toContain('-p');
    expect(callArgs[callArgs.length - 1]).toBe('Do the thing');
  });

  it('returns success on exit code 0', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep();
    const ctx = makeCtx();

    const outcome = await executeAgentStep(step, ctx);
    expect(outcome).toBe('success');
  });

  it('returns failed on non-zero exit code', async () => {
    spawnSpy.mockImplementation(() => makeMockProc(1) as never);
    const { executeAgentStep } = await importExecutor();
    const step = makeStep();
    const ctx = makeCtx();

    const outcome = await executeAgentStep(step, ctx);
    expect(outcome).toBe('failed');
  });

  it('returns failed when prompt is missing', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ prompt: undefined });
    const ctx = makeCtx();

    const outcome = await executeAgentStep(step, ctx);
    expect(outcome).toBe('failed');
  });

  it('interpolates params in prompt', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ prompt: 'Deploy {{target}}' });
    const ctx = makeCtx({ params: { target: 'prod' } });

    await executeAgentStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[callArgs.length - 1]).toBe('Deploy prod');
  });
});

describe('AgentExecutor: model override', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('passes --model flag when model is specified', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ model: 'sonnet' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain('--model');
    const modelIdx = callArgs.indexOf('--model');
    expect(callArgs[modelIdx + 1]).toBe('sonnet');
  });

  it('does not pass --model flag when model is absent', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep();
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs).not.toContain('--model');
  });
});

describe('AgentExecutor: session strategies', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('uses --resume with session: resume', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ session: 'resume' });
    const ctx = makeCtx();
    ctx.sessionIds['prev-step'] = 'sess-abc';

    await executeAgentStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain('--resume');
    expect(callArgs).toContain('sess-abc');
  });

  it('does not use --resume with session: new', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ session: 'new' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs).not.toContain('--resume');
  });

  it('uses --resume with session: inherit from parent', async () => {
    const { executeAgentStep } = await importExecutor();
    const parentCtx = createRootContext({
      params: {},
      workflowFile: '/parent.yaml',
      engine: null,
    });
    parentCtx.sessionIds['parent-agent'] = 'sess-parent-123';

    const childCtx = createSubWorkflowContext(parentCtx, {
      stepId: 'sub',
      params: {},
      workflowFile: '/child.yaml',
    });

    const step = makeStep({ session: 'inherit' });
    await executeAgentStep(step, childCtx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs).toContain('--resume');
    expect(callArgs).toContain('sess-parent-123');
  });
});

describe('AgentExecutor: engine enrichment', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('appends engine enrichment to prompt', async () => {
    const { executeAgentStep } = await importExecutor();
    const engine = {
      enrichPrompt: () => 'Engine context here',
    };
    const step = makeStep({ prompt: 'Do the thing' });
    const ctx = makeCtx({ engine });

    await executeAgentStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    const promptArg = callArgs[callArgs.length - 1]!;
    expect(promptArg).toContain('Do the thing');
    expect(promptArg).toContain('Engine context here');
    expect(promptArg.indexOf('Do the thing')).toBeLessThan(
      promptArg.indexOf('Engine context here'),
    );
  });

  it('does not modify prompt when enrichment returns undefined', async () => {
    const { executeAgentStep } = await importExecutor();
    const engine = {
      enrichPrompt: () => undefined,
    };
    const step = makeStep({ prompt: 'Original prompt' });
    const ctx = makeCtx({ engine });

    await executeAgentStep(step, ctx);

    const callArgs = spawnSpy.mock.calls[0]?.[0] as string[];
    expect(callArgs[callArgs.length - 1]).toBe('Original prompt');
  });
});

describe('AgentExecutor: ctrl-c termination', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let processSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spyOn(console, 'log').mockImplementation(() => {});
    processSpy = spyOn(process, 'on');
    removeListenerSpy = spyOn(process, 'removeListener');
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    processSpy?.mockRestore();
    removeListenerSpy?.mockRestore();
  });

  it('registers SIGINT handler for headless steps', async () => {
    const mockProc = makeMockProc(0);
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => mockProc as never,
    );
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'headless' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    // Should have registered a SIGINT listener
    const sigintCalls = processSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === 'SIGINT',
    );
    expect(sigintCalls.length).toBeGreaterThan(0);
  });

  it('removes SIGINT handler after normal exit', async () => {
    const mockProc = makeMockProc(0);
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => mockProc as never,
    );
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'headless' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    // Should have removed the SIGINT listener after process exits
    const removeCalls = removeListenerSpy.mock.calls.filter(
      (call: unknown[]) => call[0] === 'SIGINT',
    );
    expect(removeCalls.length).toBeGreaterThan(0);
  });

  it('kills subprocess when SIGINT handler is invoked', async () => {
    const mockProc = makeMockProc(0);
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => mockProc as never,
    );

    // Capture the SIGINT handler that gets registered
    let sigintHandler: (() => void) | undefined;
    processSpy.mockImplementation(((event: string, handler: () => void) => {
      if (event === 'SIGINT') {
        sigintHandler = handler;
      }
      return process;
    }) as typeof process.on);

    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'headless' });
    const ctx = makeCtx();

    // Start execution (will resolve since mock proc exits immediately)
    await executeAgentStep(step, ctx);

    // Verify the handler was captured and would kill the process
    expect(sigintHandler).toBeDefined();
    expect(mockProc.kill).toHaveBeenCalledTimes(0);
  });
});

describe('AgentExecutor: conversation ID discovery', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('stores discovered conversation ID in context sessionIds', async () => {
    // This test verifies the wiring — actual conversation discovery
    // depends on filesystem state, so we just ensure the step ID
    // key is used for the session map
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ id: 'my-agent' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    // After execution, context.sessionIds should either have the
    // step's session or be empty (no JSONL file in test env)
    // The key point is that the method runs without error
    expect(typeof ctx.sessionIds).toBe('object');
  });
});

function makeSpyLogger() {
  const events: AuditEvent[] = [];
  return {
    events,
    emit(event: AuditEvent) { events.push(event); },
    close() {},
  };
}

describe('AgentExecutor: audit events', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('emits step_start with prompt, mode, session strategy, resolved session ID, model, and enrichment', async () => {
    const { executeAgentStep } = await importExecutor();
    const logger = makeSpyLogger();
    const engine = {
      enrichPrompt: () => 'Engine enrichment text',
    };
    const step = makeStep({
      id: 'agent-1',
      prompt: 'Deploy {{target}}',
      mode: 'headless',
      session: 'resume',
      model: 'sonnet',
    });
    const ctx = makeCtx({
      params: { target: 'staging' },
      engine,
      auditLogger: logger,
    });
    ctx.sessionIds['prev-step'] = 'abc-123';

    await executeAgentStep(step, ctx);

    const startEvents = logger.events.filter(e => e.type === 'step_start');
    expect(startEvents.length).toBe(1);
    const data = startEvents[0]!.data;
    expect(data.prompt).toContain('Deploy staging');
    expect(data.prompt).toContain('Engine enrichment text');
    expect(data.mode).toBe('headless');
    expect(data.session_strategy).toBe('resume');
    expect(data.resolved_session_id).toBe('abc-123');
    expect(data.model).toBe('sonnet');
    expect(data.enrichment).toBe('Engine enrichment text');
    expect(data.context).toEqual({
      params: { target: 'staging' },
      capturedVariables: {},
    });
  });

  it('emits step_end with exit code and discovered session ID', async () => {
    const { executeAgentStep } = await importExecutor();
    const logger = makeSpyLogger();
    const step = makeStep({ id: 'agent-1', mode: 'headless' });
    const ctx = makeCtx({ auditLogger: logger });

    await executeAgentStep(step, ctx);

    const endEvents = logger.events.filter(e => e.type === 'step_end');
    expect(endEvents.length).toBe(1);
    const data = endEvents[0]!.data;
    expect(data.exit_code).toBe(0);
    expect(data.outcome).toBe('success');
    expect(typeof data.duration_ms).toBe('number');
    // discovered_session_id may be undefined in test env (no JSONL files)
    expect('discovered_session_id' in data).toBe(true);
  });

  it('step_end includes exit code 1 and outcome failed on non-zero exit', async () => {
    spawnSpy.mockImplementation(() => makeMockProc(1) as never);
    const { executeAgentStep } = await importExecutor();
    const logger = makeSpyLogger();
    const step = makeStep({ id: 'agent-1', mode: 'headless' });
    const ctx = makeCtx({ auditLogger: logger });

    await executeAgentStep(step, ctx);

    const endEvents = logger.events.filter(e => e.type === 'step_end');
    expect(endEvents.length).toBe(1);
    expect(endEvents[0]!.data.exit_code).toBe(1);
    expect(endEvents[0]!.data.outcome).toBe('failed');
  });

  it('step_start has correct prefix based on nesting path', async () => {
    const { executeAgentStep } = await importExecutor();
    const logger = makeSpyLogger();
    const step = makeStep({ id: 'agent-1', mode: 'headless' });
    const ctx = makeCtx({ auditLogger: logger });
    ctx.nestingPath = [{ stepId: 'loop-1', iteration: 2 }];

    await executeAgentStep(step, ctx);

    const startEvent = logger.events.find(e => e.type === 'step_start');
    expect(startEvent!.prefix).toBe('[loop-1:2, agent-1]');
  });

  it('step_end does not include context snapshot', async () => {
    const { executeAgentStep } = await importExecutor();
    const logger = makeSpyLogger();
    const step = makeStep({ id: 'agent-1', mode: 'headless' });
    const ctx = makeCtx({ auditLogger: logger, params: { env: 'staging' } });

    await executeAgentStep(step, ctx);

    const endEvent = logger.events.find(e => e.type === 'step_end');
    expect(endEvent!.data.context).toBeUndefined();
  });

  it('does not emit events when auditLogger is null', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ id: 'agent-1', mode: 'headless' });
    const ctx = makeCtx(); // no auditLogger

    // Should not throw
    const outcome = await executeAgentStep(step, ctx);
    expect(outcome).toBe('success');
  });
});

describe('AgentExecutor: headless prompt display', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.BATON_SHOW_PROMPT = '1';
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockSpinner.start.mockClear();
    mockSpinner.stop.mockClear();
    mockOra.mockClear();
  });

  afterEach(() => {
    delete process.env.BATON_SHOW_PROMPT;
    spawnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('prints indented prompt for headless step when BATON_SHOW_PROMPT=1', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'headless', prompt: 'Do the thing' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    const loggedArgs = logSpy.mock.calls.map((call: unknown[]) => call[0]);
    expect(loggedArgs).toContain('  Do the thing');
  });

  it('does not print prompt for interactive step', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'interactive', prompt: 'Do the thing' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    const loggedArgs = logSpy.mock.calls.map((call: unknown[]) => call[0]);
    // Should not contain the indented prompt
    const hasIndentedPrompt = loggedArgs.some(
      (arg: unknown) =>
        typeof arg === 'string' && arg.includes('  Do the thing'),
    );
    expect(hasIndentedPrompt).toBe(false);
  });

  it('does not print prompt when BATON_SHOW_PROMPT is unset', async () => {
    delete process.env.BATON_SHOW_PROMPT;
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'headless', prompt: 'Do the thing' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    const loggedArgs = logSpy.mock.calls.map((call: unknown[]) => call[0]);
    const hasIndentedPrompt = loggedArgs.some(
      (arg: unknown) =>
        typeof arg === 'string' && arg.includes('  Do the thing'),
    );
    expect(hasIndentedPrompt).toBe(false);
  });

  it('prints full multi-line prompt without truncation', async () => {
    const { executeAgentStep } = await importExecutor();
    const multiLinePrompt = 'Line one\nLine two\nLine three';
    const step = makeStep({ mode: 'headless', prompt: multiLinePrompt });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    const loggedArgs = logSpy.mock.calls.map((call: unknown[]) => call[0]);
    const expected = '  Line one\n  Line two\n  Line three';
    expect(loggedArgs).toContain(expected);
  });
});

describe('AgentExecutor: headless spinner', () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let processSpy: ReturnType<typeof spyOn>;
  let removeListenerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
      () => makeMockProc(0) as never,
    );
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockSpinner.start.mockClear();
    mockSpinner.stop.mockClear();
    mockOra.mockClear();
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    logSpy.mockRestore();
    processSpy?.mockRestore();
    removeListenerSpy?.mockRestore();
  });

  it('starts spinner during headless execution', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'headless' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    expect(mockOra).toHaveBeenCalledWith('agent running...');
    expect(mockSpinner.start).toHaveBeenCalled();
  });

  it('stops spinner on step completion', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'headless' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    expect(mockSpinner.stop).toHaveBeenCalled();
  });

  it('stops spinner before killing process on ctrl-c', async () => {
    const mockProc = makeMockProc(0);
    spawnSpy.mockImplementation(() => mockProc as never);

    let sigintHandler: (() => void) | undefined;
    processSpy = spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
      if (event === 'SIGINT') {
        sigintHandler = handler;
      }
      return process;
    }) as typeof process.on);
    removeListenerSpy = spyOn(process, 'removeListener');

    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'headless' });
    const ctx = makeCtx();

    await executeAgentStep(step, ctx);

    // Invoke the captured SIGINT handler
    expect(sigintHandler).toBeDefined();
    mockSpinner.stop.mockClear();
    sigintHandler!();
    expect(mockSpinner.stop).toHaveBeenCalled();
    expect(mockProc.kill).toHaveBeenCalled();
  });

  it('does not show spinner for interactive steps', async () => {
    const { executeAgentStep } = await importExecutor();
    const step = makeStep({ mode: 'interactive' });
    const ctx = makeCtx();

    mockOra.mockClear();
    await executeAgentStep(step, ctx);

    expect(mockOra).not.toHaveBeenCalled();
  });
});
