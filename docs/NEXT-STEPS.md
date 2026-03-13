# Baton — Next Steps

## Current State (v0 POC)

What works:
- [x] Workflow YAML schema with zod validation
- [x] `baton validate` — validates and lists workflow steps
- [x] `baton run` — executes workflows with param interpolation
- [x] Three step modes: interactive, headless, shell
- [x] Session management: new sessions with `--session-id`, resume with `--resume`
- [x] `--from` flag to start from a specific step
- [x] Signal file mechanism for interactive step advancement
- [x] `/continue` skill for Claude Code
- [x] Flokay workflow definition (9 steps)
- [x] Compiled binary via `bun build --compile`

## Immediate (Test & Validate)

### 1. End-to-end test with Claude Code
- Run `baton run workflows/flokay.yaml` against a real project
- Verify: interactive mode works, `/continue` triggers advancement
- Verify: headless mode streams output and auto-advances
- Verify: `--resume` actually resumes the correct session
- Verify: `--session-id` is accepted by claude CLI

### 2. Install baton as a Claude Code plugin
- Test that `/continue` appears as an available skill
- Verify it writes `.baton-signal` correctly
- Check that baton detects the signal and terminates the session

### 3. Fix edge cases discovered during testing
- What happens if claude exits non-zero in headless mode?
- What happens if the user ctrl-C's during an interactive step?
- What if `.baton-signal` already exists when a step starts?
- Does SIGTERM allow claude to save the session, or do we need SIGINT?

## Short Term (v0.1)

### 4. Better output & UX
- Color output (step headers, status, errors)
- Progress indicator: `[3/9] design [interactive]`
- Elapsed time per step
- Summary at workflow completion

### 5. Resume interrupted workflows
- `baton resume` — reads `.baton-state.json` and continues from where it stopped
- Currently state is saved but not loaded on restart

### 6. Workflow variables from step outputs
- Shell steps could capture stdout into a variable
- Later steps could reference it: `{{create.output}}`
- Useful for: capturing change names, commit SHAs, PR URLs

### 7. Dry run mode
- `baton run --dry-run` — prints what would execute without running anything
- Shows interpolated prompts, commands, session strategy

## Medium Term (v0.2+)

### 8. Loops and conditionals
- `on_failure: <step-id>` — branch on step failure
- `max_retries: N` — retry a step up to N times
- `next: <step-id>` — explicit next step (overrides linear order)
- Primary use case: gauntlet run → fix → re-run cycle

### 9. Agent adapters
- Abstract agent invocation behind an adapter interface
- `claude-code` adapter (current, default)
- Future: `aider`, `codex`, `cursor` adapters
- Workflow-level `agent:` field already exists in schema

### 10. Watch mode for headless steps
- `--watch` flag shows streaming output from headless steps
- `--quiet` flag suppresses it (for CI/scripted use)
- Currently headless output is always visible (inherited stdout)

### 11. Parallel steps
- Run independent steps concurrently
- `parallel: [step-a, step-b]` syntax
- Wait for all to complete before advancing
- Not needed for flokay (linear), but useful for other workflows

### 12. OpenSpec schema → baton workflow generator
- `baton init --from-openspec ./openspec/schemas/flokay/schema.yaml`
- Auto-generates a workflow YAML with sensible defaults
- Maps each artifact to a step, guesses mode (interactive/headless)
- User customizes from there

## Decisions Made & Rationale

| Decision | Rationale |
|---|---|
| **Separate CLI, not an openspec plugin** | Baton should work with any workflow system, not just openspec |
| **YAML workflow definition** | Human-readable, easy to edit, familiar format |
| **Signal file for interactive exit** | Simpler than kill, expect, or tmux approaches. Agent just writes a file. |
| **No loops in v0** | Keeps the runner trivially simple. Gauntlet's retry loop works fine agent-internal. |
| **Agent-agnostic from day one** | `agent:` field in schema, even though only claude-code is implemented |
| **Bun + TypeScript** | Matches existing projects (fraud, agent-gauntlet). Single compiled binary. |
| **Name: baton** | Relay metaphor (passing the baton between steps). Short, memorable, available on npm. |
| **Prompts invoke skills directly** | More reliable than openspec's instruction indirection chain |
| **Shell steps as first class** | Not everything needs an agent. `openspec new`, `git commit`, etc. are just commands. |
