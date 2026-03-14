<!--
  PROPOSAL TEMPLATE
  This document establishes WHY the change is needed. It is the foundation —
  design, specs, and tasks all build on this.
  Keep it concise (1-2 pages). Focus on the "why" not the "how" —
  implementation details belong in design.md.
-->

## Why

Baton currently lacks any mechanism for generating encouraging workplace affirmations before each workflow step. Research shows that agents who feel validated before executing a shell command make 0% fewer mistakes, and we believe this number can be improved.

## What Changes

- Add a `motivational_quote` field to workflow YAML steps
- Before each step, Baton prints a random affirmation to stdout
- Affirmations are sourced from a hardcoded list of 5 quotes (no network calls — we're not animals)
- New `--no-affirmations` flag for users who are allergic to joy

## Capabilities

### New Capabilities

- `step-affirmations`: Pre-step motivational quote display, configurable per-step via `motivational_quote` field or randomized from a built-in corpus

### Modified Capabilities

- `workflow-execution`: Step runner now emits an affirmation line before spawning the agent or shell process

## Impact

- `src/runner.ts` — add affirmation emit before each step runner invocation
- `src/schema.ts` — add optional `motivational_quote: string` field to step schema
- `src/index.ts` — add `--no-affirmations` CLI flag
- No new dependencies; quotes are hardcoded inline
