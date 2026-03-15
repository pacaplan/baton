# Baton

CLI workflow orchestrator for AI agents. Runs multi-step workflows by spawning separate agent sessions for each step, keeping orchestration deterministic and outside the agent.

## Why

Agents are good at execution, bad at orchestration. When given a complex multi-step workflow, they lose track of sequence, skip steps, accumulate stale context, and ignore instructions buried deep in prompts. Baton solves this by moving orchestration out of the agent entirely. Each step gets a fresh or resumed session, a focused prompt in the highest-attention position, and a single responsibility.

## Why not use an existing workflow tool?

There are many YAML-based workflow engines (Argo, Kestra, Step Functions) and CLI task runners (Taskfile, Just, Make). The cloud/server orchestrators have rich control flow but can't run local CLI processes. The CLI task runners can run shell commands but collapse into bash scripts the moment you need loop-until with multi-step bodies, mid-pipeline output capture, or conditional branching. None of them have the concepts that agent orchestration requires: session management across steps, interactive/headless mode switching, prompt-based agent steps, or signal-based advancement. Baton borrows proven workflow primitives (for-each, loop-until, sub-workflows, output capture) from these systems and adds a purpose-built runtime for orchestrating stateful conversational agents. See [docs/WHY-BATON.md](docs/WHY-BATON.md) for the full comparison.

## Features

- **Three step modes**: interactive (collaborative), headless (autonomous), shell (CLI commands)
- **Session management**: `new`, `resume`, or `inherit` sessions across steps and sub-workflows
- **Loops**: counted loops (`loop: { max: N }`) and for-each loops (`loop: { over, as }`) with `break_if` conditions
- **Sub-workflows**: compose workflows from reusable workflow files with parameter passing
- **Output capture**: capture shell stdout into variables for use in subsequent steps (`capture` field with tee behavior)
- **Flow control**: `continue_on_failure`, `skip_if: previous_success`, `break_if: success|failure`
- **Per-step model override**: specify which model an agent step should use (`model` field)
- **State and resumption**: `baton-state.json` persists after each step for resume on interruption
- **Audit logging**: structured log of every execution event (step start/end, iterations, sub-workflows) for post-failure troubleshooting
- **Engines**: pluggable lifecycle hooks for prompt enrichment, step validation, and state management

## Install

Requires [Bun](https://bun.sh) v1.0+.

```bash
bun install
bun run build       # compiles to bin/baton
```

## Quick start

```bash
# Validate a workflow
baton validate workflows/flokay.yaml

# Run a workflow with parameters
baton run workflows/flokay.yaml my-change-name

# Start from a specific step
baton run workflows/flokay.yaml my-change-name --from design

# Resume an interrupted workflow
baton resume path/to/baton-state.json
```

## How it works

Baton reads a YAML workflow file and executes steps sequentially. Each step is one of several types:

| Type | What happens | Use case |
|------|-------------|----------|
| **interactive** | Agent runs with full stdin. User works with it, types `/continue` to advance. | Collaborative steps (proposal, specs, design) |
| **headless** | Agent runs with `-p` flag. Output streams to terminal. Auto-advances on exit. | Autonomous steps (tasks, review, implementation) |
| **shell** | Runs a shell command directly, no agent. | CLI operations (`openspec new`, `git commit`) |
| **loop** | Repeats child steps (counted or for-each). | Iterating over tasks, retry loops |
| **sub-workflow** | Invokes another workflow file. | Reusable workflow composition |

```
baton (harness)
  |
  +-- step 1: shell        -> sh -c "openspec new change my-feature"
  +-- step 2: interactive  -> claude "Write the proposal..."
  +-- step 3: headless     -> claude -p "Generate specs..."
  +-- step 4: loop (per-task)
  |     +-- step 4a: headless  -> claude -p "Implement {{task_file}}"
  |     +-- step 4b: sub-workflow -> workflows/run-gauntlet.yaml
  +-- step 5: headless     -> claude -p "Finalize..."
```

### Session management

Each agent step declares a session strategy:

- **`session: new`** -- Fresh session, no prior context. Agent reads what it needs from disk.
- **`session: resume`** -- Continues the most recent session within the current workflow.
- **`session: inherit`** -- Crosses sub-workflow boundaries to resume the parent workflow's most recent session.

### State and resumption

Baton writes `baton-state.json` after each step. If a workflow is interrupted, `baton resume` picks up from where it left off, including persisted session IDs, captured variables, and parameters. State is recursive -- nested loops and sub-workflows track their own position.

### Engines

Workflows can declare an **engine** that hooks into the execution lifecycle:

- **`enrichPrompt`** -- Append context (templates, output paths, dependencies) to step prompts
- **`validateStep`** -- Verify expected output was created after a step
- **`validateWorkflow`** -- Check workflow structure at load time
- **`getStateDir`** -- Control where the state file lives

The built-in `openspec` engine integrates with the [OpenSpec](https://github.com/pacaplan/openspec) CLI to inject artifact context and validate artifact completion.

## Workflow format

```yaml
name: my-workflow
description: "What this workflow does"
agent: claude-code

params:
  - name: change_name
    required: true

engine:                          # optional
  type: openspec
  change_param: change_name

steps:
  - id: create
    mode: shell
    command: openspec new change "{{change_name}}"

  - id: proposal
    mode: interactive
    session: new
    prompt: /flokay:propose "{{change_name}}"

  - id: implement
    workflow: implement-change.yaml
    params:
      change_name: "{{change_name}}"

  - id: verify
    mode: headless
    session: new
    model: sonnet
    prompt: "Verify the implementation"
```

### Step fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique step identifier. Used for `--from`, state tracking, and engine matching. |
| `mode` | agent/shell | `interactive`, `headless`, or `shell` |
| `prompt` | agent steps | Prompt passed to the agent. Supports `{{param}}` interpolation. |
| `command` | shell steps | Shell command to execute. Supports `{{param}}` interpolation. |
| `session` | no | `new` (default), `resume`, or `inherit`. Only applies to agent steps. |
| `model` | no | Model override for agent steps. Passed as `--model <value>` to claude. |
| `capture` | no | Variable name to capture shell stdout into. Shell steps only. |
| `continue_on_failure` | no | If `true`, workflow continues even if this step fails. |
| `skip_if` | no | `previous_success` -- skip this step if the prior step succeeded. |
| `break_if` | no | `success` or `failure` -- break out of enclosing loop on this condition. |
| `loop` | no | `{ max: N }` for counted loops, `{ over: glob, as: var }` for for-each. |
| `steps` | loop/group | Nested child steps (required for loops, optional for groups). |
| `workflow` | sub-workflow | Path to another workflow YAML file. |
| `params` | sub-workflow | Parameters to pass to the sub-workflow. |

### Parameter interpolation

Parameters declared in `params:` are passed as positional arguments:

```bash
baton run workflow.yaml value1 value2
```

Referenced in prompts and commands as `{{param_name}}`. Captured variables from shell steps are also available via `{{var_name}}`.

## CLI reference

```
baton run <workflow.yaml> [params...] [--from <step>]
baton validate <workflow.yaml> [params...]
baton resume <state-file-path>
```

## Architecture

```
src/
  index.ts              # CLI entry (commander)
  schema.ts             # Zod schemas (workflow, step, param, engine, loop)
  loader.ts             # YAML loading, param interpolation
  engine.ts             # Engine interface, registry, createEngine()
  context.ts            # ExecutionContext, nesting, sub-workflow contexts
  state.ts              # State file read/write/delete
  runner.ts             # Top-level step dispatch loop
  audit.ts              # AuditLogger, buildPrefix, log file management
  executors/
    agent.ts            # Agent step executor (headless + interactive)
    shell.ts            # Shell step executor (with capture)
    loop.ts             # Loop executor (counted + for-each)
    sub-workflow.ts     # Sub-workflow executor
  shared/
    flow-control.ts     # skip_if, break_if evaluation
    interpolation.ts    # {{variable}} interpolation
    session.ts          # Session resolution (new, resume, inherit)
  engines/
    openspec.ts         # OpenSpec engine implementation
  commands/
    run.ts              # baton run
    resume.ts           # baton resume
    validate.ts         # baton validate
    index.ts            # re-exports
```

## Development

```bash
bun test              # run tests
bun run lint          # biome check
bun run typecheck     # tsc --noEmit
bun run build         # compile to bin/baton
```

## License

MIT
