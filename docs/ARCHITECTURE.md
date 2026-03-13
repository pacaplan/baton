# Baton — Architecture & Design Decisions

## What Baton Is

Baton is an external CLI harness that orchestrates AI agent workflows by spawning **separate agent sessions** for each step of a declarative YAML-defined pipeline. Instead of asking the agent to self-orchestrate a multi-step workflow (which is unreliable), baton enforces the sequence deterministically from outside.

```
┌─────────────┐
│   baton      │──── workflow.yaml
│   (harness)  │
└──────┬───────┘
       │
       ├── spawn: claude "prompt for step 1"    [interactive]
       │   └── user works, types /continue
       │
       ├── spawn: claude --resume <id> "step 2"  [headless]
       │   └── auto-advances on exit
       │
       ├── shell: openspec validate ...           [shell]
       │   └── runs directly, no agent
       │
       └── spawn: claude "prompt for step 3"      [headless]
           └── auto-advances on exit
```

## The Core Thesis

**Agents are good at execution, bad at orchestration.**

When you give an agent a complex multi-step workflow (like "create a proposal, then specs, then design, then tasks, then review, then implement, then verify, then push a PR"), it:

- Loses track of where it is in the sequence
- Skips steps or does them out of order
- Accumulates context that degrades quality in later steps
- Fails to follow instructions embedded deep in schema files

Baton solves this by moving orchestration out of the agent entirely. Each step gets:
- A **fresh or resumed session** (design-time choice)
- A **focused prompt** as the first thing the agent sees (highest attention position)
- A **single responsibility** (do one thing, then exit)

## Three Step Modes

### Interactive

Agent runs in full interactive mode. Human works with the agent. When done, the user invokes `/continue` (a baton skill) which writes a `.baton-signal` file. Baton's file watcher detects this and terminates the session, advancing to the next step.

```
baton spawns: claude --session-id <id> "prompt"
  → user interacts with claude
  → user types /continue
  → .baton-signal file written
  → baton detects, kills process, moves on
```

### Headless

Agent runs non-interactively with `-p` flag. Output streams to the terminal so the user can watch. When claude finishes, it exits naturally and baton advances. Multiple headless steps can chain without human intervention.

```
baton spawns: claude -p --session-id <id> "prompt"
  → claude executes, prints output
  → claude exits (code 0)
  → baton moves to next step
```

### Shell

No agent involved. Baton runs a shell command directly. Useful for CLI operations like `openspec new change`, `git commit`, `openspec validate`, etc.

```
baton runs: sh -c "openspec new change my-change"
  → command executes
  → baton checks exit code, moves on
```

## Session Management

Each step declares its session strategy:

- **`session: new`** — Fresh session. Agent starts with no prior context. Reads what it needs from disk.
- **`session: resume`** — Resumes the previous step's session. Agent has full conversational context from earlier.

Baton tracks session IDs in `.baton-state.json` and passes `--session-id` when creating new sessions and `--resume` when continuing.

**When to use which:**

| Use `new` when... | Use `resume` when... |
|---|---|
| Context would be bloated | Steps are tightly coupled |
| Step reads everything from files | Step needs conversational context |
| You want the agent to start fresh | Steps share intermediate decisions |
| Different concern than previous | Continuation of same concern |

## Relationship to OpenSpec

Baton is **additive to OpenSpec**, not a replacement. OpenSpec still provides:

- **Spec validation** — structural rules, SHALL/MUST enforcement, scenario requirements
- **Delta merge** — ADDED/MODIFIED/REMOVED/RENAMED operations on specs
- **Directory conventions** — `openspec/changes/<name>/` structure
- **Templates** — markdown templates for artifacts

Baton replaces the **orchestration layer** that was previously handled by:
- `/opsx:ff` (fast-forward through all artifacts)
- `/opsx:continue` (continue to next artifact)
- `/opsx:apply` (implement tasks)
- `openspec instructions` (schema instruction delivery)

These worked by embedding workflow logic in agent instructions and hoping the agent followed them. Baton makes the sequence deterministic.

```
BEFORE:
  openspec schema → opsx skills → agent self-orchestrates (unreliable)

AFTER:
  baton workflow → baton harness → agent runs one skill per step (reliable)
```

### What OpenSpec Still Does

The `openspec` CLI is still called for:
- `openspec new change` — scaffolding (as a shell step)
- `openspec validate` — spec validation (as a shell step or within agent steps)
- Delta merge at archive time — `openspec apply-specs`

### What Baton Replaces

The schema `instruction` fields become documentation rather than runtime control. The agent no longer discovers what to do via `openspec instructions` — baton tells it directly in the prompt.

## Relationship to Flokay

Flokay skills (`/flokay:propose`, `/flokay:spec`, `/flokay:design`, `/flokay:plan-tasks`, `/flokay:finalize-pr`) do the **actual work**. They are unchanged. Baton's workflow prompts invoke them directly:

```yaml
- id: specs
  prompt: |
    Run /flokay:spec for change "{{change_name}}".
```

This is more reliable than the previous approach where `openspec instructions` returned an instruction saying "use flokay:spec" and the agent often ignored it. With baton, the skill name is in the **first line of the prompt** — the highest-attention position for the model.

## Relationship to Agent Gauntlet

Agent Gauntlet runs in two contexts:
1. **During implementation** — inside `flokay:implement-task` subagents (unchanged)
2. **As a review step** — the `review` artifact in the flokay workflow

For v0, gauntlet-run stays as an agent-internal loop (run → check → fix → re-run). The retry cycle works well within a single session because it's a tight, same-context loop. Decomposing it into relay steps would require loop support in baton, which is a future feature.

## Signal Mechanism

The `/continue` skill is a baton plugin skill. When invoked, it writes a JSON file:

```bash
echo '{"action":"continue"}' > .baton-signal
```

Baton polls for this file every 500ms. When detected, it:
1. Reads and deletes the signal file
2. Sends SIGTERM to the claude process
3. Advances to the next workflow step

This avoids the need for the agent to kill its own process (which claude hesitates to do) and keeps the signal mechanism clean and simple.

## Agent Agnosticism

Baton is designed to work with Claude Code today but could support other agents in the future. The agent interaction is isolated in the runner:

- `claude --session-id <id> "prompt"` for interactive
- `claude -p --session-id <id> "prompt"` for headless

Adding support for another agent (e.g., aider, codex) would mean adding an adapter that translates these operations into the agent's CLI interface.

## File Layout

```
baton/
├── .claude-plugin/
│   └── plugin.json          # Claude Code plugin manifest
├── skills/
│   └── continue/
│       └── SKILL.md         # /continue skill — writes signal file
├── src/
│   ├── index.ts             # CLI entrypoint
│   ├── schema.ts            # Zod schemas for workflow YAML
│   ├── loader.ts            # YAML loading + param interpolation
│   └── runner.ts            # Step execution engine
├── workflows/
│   └── flokay.yaml          # Flokay workflow definition
├── package.json
├── tsconfig.json
└── biome.json
```
