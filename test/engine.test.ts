import { describe, expect, it } from 'bun:test';
import { createEngine, registerEngine } from '../src/engine.ts';
import type { Engine } from '../src/engine.ts';

describe('createEngine', () => {
  it('throws for unrecognized engine type', () => {
    expect(() => createEngine({ type: 'foo' })).toThrow(
      'Unknown engine type: "foo"',
    );
  });

  it('throws for unrecognized engine type with descriptive error', () => {
    expect(() => createEngine({ type: 'nonexistent' })).toThrow(
      'Unknown engine type: "nonexistent"',
    );
  });
});

describe('registerEngine', () => {
  it('registers an engine and createEngine returns it', () => {
    const mockEngine: Engine = {
      validateWorkflow: () => {},
    };
    registerEngine('test-engine', (_config) => mockEngine);

    const engine = createEngine({ type: 'test-engine' });
    expect(engine).toBe(mockEngine);
  });

  it('passes remaining config fields to constructor', () => {
    let receivedConfig: Record<string, unknown> = {};
    registerEngine('config-test', (config) => {
      receivedConfig = config;
      return {};
    });

    createEngine({ type: 'config-test', param1: 'value1', param2: 42 });
    expect(receivedConfig).toEqual({ param1: 'value1', param2: 42 });
  });
});
