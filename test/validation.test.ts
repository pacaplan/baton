import { describe, expect, it } from 'bun:test';
import { validateWorkflowConstraints } from '../src/loader.ts';
import type { Step, Workflow } from '../src/schema.ts';

function makeWorkflow(steps: Step[]): Workflow {
  return {
    name: 'test-wf',
    agent: 'claude-code',
    params: [],
    steps,
  };
}

describe('validateWorkflowConstraints', () => {
  it('rejects skip_if on first step in workflow', () => {
    const wf = makeWorkflow([
      {
        id: 'first',
        mode: 'shell',
        command: 'echo hi',
        session: 'new',
        skip_if: 'previous_success',
      },
    ]);
    expect(() => validateWorkflowConstraints(wf)).toThrow(
      /skip_if.*first step/i,
    );
  });

  it('accepts skip_if on second step in workflow', () => {
    const wf = makeWorkflow([
      {
        id: 'first',
        mode: 'shell',
        command: 'echo hi',
        session: 'new',
      },
      {
        id: 'second',
        mode: 'shell',
        command: 'echo fix',
        session: 'new',
        skip_if: 'previous_success',
      },
    ]);
    expect(() => validateWorkflowConstraints(wf)).not.toThrow();
  });

  it('rejects skip_if on first step in loop body', () => {
    const wf = makeWorkflow([
      {
        id: 'loop1',
        loop: { max: 3 },
        steps: [
          {
            id: 'first-in-loop',
            mode: 'shell',
            command: 'echo try',
            session: 'new',
            skip_if: 'previous_success',
          },
        ],
        session: 'new',
      },
    ]);
    expect(() => validateWorkflowConstraints(wf)).toThrow(
      /skip_if.*first step/i,
    );
  });

  it('rejects break_if outside loop body', () => {
    const wf = makeWorkflow([
      {
        id: 'not-in-loop',
        mode: 'shell',
        command: 'echo hi',
        session: 'new',
        break_if: 'success',
      },
    ]);
    expect(() => validateWorkflowConstraints(wf)).toThrow(
      /break_if.*only.*loop/i,
    );
  });

  it('accepts break_if inside loop body', () => {
    const wf = makeWorkflow([
      {
        id: 'loop1',
        loop: { max: 3 },
        steps: [
          {
            id: 'in-loop',
            mode: 'shell',
            command: 'echo try',
            session: 'new',
            break_if: 'success',
          },
        ],
        session: 'new',
      },
    ]);
    expect(() => validateWorkflowConstraints(wf)).not.toThrow();
  });

  it('rejects session: inherit in top-level workflow', () => {
    const wf = makeWorkflow([
      {
        id: 'inherit-step',
        mode: 'headless',
        prompt: 'do stuff',
        session: 'inherit',
      },
    ]);
    expect(() => validateWorkflowConstraints(wf)).toThrow(
      /session.*inherit.*top-level/i,
    );
  });

  it('accepts session: inherit in nested steps', () => {
    const wf = makeWorkflow([
      {
        id: 'loop1',
        loop: { max: 3 },
        steps: [
          {
            id: 'in-loop',
            mode: 'headless',
            prompt: 'fix',
            session: 'inherit',
          },
        ],
        session: 'new',
      },
    ]);
    // inherit inside loop body is OK
    expect(() => validateWorkflowConstraints(wf)).not.toThrow();
  });

  it('accepts break_if inside nested group within loop', () => {
    const wf = makeWorkflow([
      {
        id: 'loop1',
        loop: { max: 3 },
        steps: [
          {
            id: 'group1',
            steps: [
              {
                id: 'nested-break',
                mode: 'shell',
                command: 'echo check',
                session: 'new',
                break_if: 'success',
              },
            ],
            session: 'new',
          },
        ],
        session: 'new',
      },
    ]);
    // break_if inside a group that's inside a loop is valid
    expect(() => validateWorkflowConstraints(wf)).not.toThrow();
  });
});
