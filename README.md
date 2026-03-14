# Baton

CLI workflow orchestrator for AI agents. Runs multi-step workflows by spawning separate agent sessions for each step, keeping orchestration deterministic and outside the agent.

## Why

Agents are good at execution, bad at orchestration. When given a complex multi-step workflow, they lose track of sequence, skip steps, accumulate stale context, and ignore instructions buried deep in prompts. Baton solves this by moving orchestration out of the agent entirely. Each step gets a fresh or resumed session, a focused prompt in the highest-attention position, and a single responsibility.

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

Baton reads a YAML workflow file and executes steps sequentially. Each step is one of three modes:

| Mode | What happens | Use case |
|------|-------------|----------|
| **interactive** | Agent runs with full stdin. User works with it, types `/continue` to advance. | Collaborative steps (proposal, specs, design) |
| **headless** | Agent runs with `-p` flag. Output streams to terminal. Auto-advances on exit. | Autonomous steps (tasks, review, implementation) |
| **shell** | Runs a shell command directly, no agent. | CLI operations (`openspec new`, `git commit`) |

```
baton (harness)
  |
  +-- step 1: shell     -> sh -c "openspec new change my-feature"
  +-- step 2: interactive -> claude "Write the proposal..."
  +-- step 3: headless   -> claude -p "Generate specs..."
  +-- step 4: headless   -> claude -p "Run tests..."
```

### Session management

Each step declares a session strategy:

- **`session: new`** -- Fresh session, no prior context. Agent reads what it needs from disk.
- **`session: resume`** -- Continues the previous step's session with full conversational context.

### State and resumption

Baton writes `baton-state.json` after each step. If a workflow is interrupted, `baton resume` picks up from where it left off, including persisted session IDs and parameters.

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

  - id: specs
    mode: interactive
    session: resume
    prompt: /flokay:spec

  - id: design
    mode: headless
    session: new
    prompt: /flokay:design
```

### Step fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique step identifier. Used for `--from`, state tracking, and engine matching. |
| `mode` | yes | `interactive`, `headless`, or `shell` |
| `prompt` | agent steps | Prompt passed to the agent. Supports `{{param}}` interpolation. |
| `command` | shell steps | Shell command to execute. Supports `{{param}}` interpolation. |
| `session` | no | `new` (default) or `resume`. Only applies to agent steps. |

### Parameter interpolation

Parameters declared in `params:` are passed as positional arguments:

```bash
baton run workflow.yaml value1 value2
```

Referenced in prompts and commands as `{{param_name}}`.

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
  schema.ts             # Zod schemas (workflow, step, param, engine)
  loader.ts             # YAML loading, param interpolation
  engine.ts             # Engine interface, registry, createEngine()
  state.ts              # State file read/write/delete
  runner.ts             # Step execution loop
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
bun test              # run tests (84 tests)
bun run lint          # biome check
bun run typecheck     # tsc --noEmit
bun run build         # compile to bin/baton
```

## License

MIT
