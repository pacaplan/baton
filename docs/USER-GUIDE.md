# Baton User Guide

## Getting started

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- [Claude Code](https://claude.com/claude-code) CLI installed and authenticated
- (Optional) [OpenSpec](https://github.com/pacaplan/openspec) CLI, if using the openspec engine

### Installation

```bash
git clone <repo-url>
cd baton
bun install
bun run build    # compiles to bin/baton
```

Add `bin/` to your PATH, or run directly with `bun src/index.ts`.

## Writing workflows

A workflow is a YAML file that defines a sequence of steps. Each step either runs an agent session, a shell command, a loop, or a sub-workflow.

### Minimal example

```yaml
name: hello
description: "A simple two-step workflow"

steps:
  - id: greet
    mode: headless
    prompt: "Say hello and list the files in the current directory."

  - id: summarize
    mode: headless
    session: resume
    prompt: "Summarize what you found."
```

Run it:

```bash
baton run hello.yaml
```

### With parameters

```yaml
name: review-pr
description: "Review a pull request"

params:
  - name: pr_number
    required: true

steps:
  - id: fetch
    mode: shell
    command: gh pr checkout {{pr_number}}

  - id: review
    mode: interactive
    session: new
    prompt: "Review the changes in this PR and suggest improvements."
```

Run it:

```bash
baton run review-pr.yaml 42
```

Parameters are positional -- they map to the `params` array in order.

## Step modes

### Interactive

The agent runs in full interactive mode. You collaborate with it in your terminal. When you're done with the step, type `/continue` (a baton plugin skill) to advance to the next step.

Behind the scenes: baton watches for a `.baton-signal` file. `/continue` writes this file, baton detects it, terminates the session, and moves on.

If you exit the session without `/continue`, baton treats the step as aborted and stops the workflow. The state file persists so you can resume later.

### Headless

The agent runs non-interactively (`claude -p`). Its output streams to your terminal so you can watch progress. When the agent finishes, baton automatically advances.

Use headless for steps that don't need human interaction -- task generation, code review, implementation, etc.

Pressing ctrl-c during a headless step kills the agent subprocess and exits baton. The state file preserves the interrupted step so you can resume later.

### Shell

No agent involved. Baton runs a shell command directly. Useful for:

- Scaffolding: `openspec new change "{{name}}"`
- Validation: `openspec validate`
- Git operations: `git commit -m "..."`
- Any CLI tool

Shell steps fail the workflow on non-zero exit codes.

## Session management

### New sessions

```yaml
- id: design
  mode: headless
  session: new
  prompt: "Design the architecture..."
```

Starts a fresh agent session with no prior context. The agent reads what it needs from disk. Use this when:

- The step has a different concern than the previous one
- Context from prior steps would be bloating or confusing
- The step is self-contained

### Resumed sessions

```yaml
- id: specs
  mode: interactive
  session: resume
  prompt: "Now write the specs based on what we discussed."
```

Continues the most recent session within the current workflow. The agent has full conversational context from earlier. Use this when:

- Steps are tightly coupled (proposal -> specs uses the same conversation)
- The agent needs to remember decisions from the prior step
- You want continuity in an ongoing dialogue

### Inherited sessions

```yaml
# Inside a sub-workflow
- id: fix
  mode: headless
  session: inherit
  prompt: "Fix the issues found by the gauntlet."
```

Crosses sub-workflow boundaries to resume the parent workflow's most recent session. Use this when:

- A sub-workflow needs to continue the conversation from the parent
- The gauntlet pattern: a sub-workflow needs to fix issues using the context of the step that created the code

`session: inherit` walks the parent context chain to find the nearest session from a different workflow file.

## Per-step model override

Agent steps can specify which model the agent should use:

```yaml
- id: quick-check
  mode: headless
  model: sonnet
  prompt: "Do a quick syntax check on the files."

- id: deep-review
  mode: headless
  model: opus
  prompt: "Do a thorough code review."
```

When `model` is set, baton passes `--model <value>` to the claude invocation. When absent, claude uses its default model. The `model` field is only valid on agent steps (headless or interactive), not shell steps.

## Loops

### Counted loops

Repeat a group of steps up to N times:

```yaml
- id: verify-fix
  loop:
    max: 3
  steps:
    - id: gauntlet
      mode: shell
      command: agent-gauntlet run
      capture: gauntlet_output
      continue_on_failure: true
      break_if: success

    - id: fix
      mode: headless
      session: new
      prompt: |
        The gauntlet found issues:
        {{gauntlet_output}}
        Fix them.
      skip_if: previous_success
```

The loop runs up to 3 times. If `break_if: success` triggers on the gauntlet step (exit code 0), the loop exits early. If the loop exhausts all iterations without breaking, it fails the workflow.

### For-each loops

Iterate over a list of files matching a glob pattern:

```yaml
- id: per-task
  loop:
    over: "openspec/changes/{{change_name}}/tasks/*.task.md"
    as: task_file
  steps:
    - id: implement
      mode: headless
      session: new
      prompt: "Implement {{task_file}}"
```

The `over` field accepts a glob pattern, expanded at runtime. Each match is bound to the variable named in `as`, available via `{{task_file}}` interpolation in nested steps. Each iteration gets a fresh context for session IDs and captured variables.

### Loop early exit with break_if

`break_if` is evaluated after a step executes:

- `break_if: success` -- exit the enclosing loop if the step succeeded
- `break_if: failure` -- exit the enclosing loop if the step failed

Execution continues with the next step after the loop.

## Sub-workflows

Complex patterns can be extracted into reusable workflow files:

```yaml
# workflows/implement-task.yaml
name: implement-task
params:
  - name: task_file
    required: true

steps:
  - id: implement
    mode: headless
    session: new
    prompt: "Implement the task described in {{task_file}}."

  - id: run-gauntlet
    workflow: workflows/run-gauntlet.yaml
```

Invoke from a parent workflow:

```yaml
- id: implement-single-task
  workflow: workflows/implement-task.yaml
  params:
    task_file: "{{task_file}}"
```

Sub-workflows:

- Execute in the same process
- Get their own execution context (session IDs, captured variables)
- Receive only explicitly passed parameters
- Can nest arbitrarily (sub-workflow calling sub-workflow)
- Support `session: inherit` to resume a parent session

## Flow control

### continue_on_failure

By default, a failed step stops the workflow. `continue_on_failure: true` allows the workflow to proceed:

```yaml
- id: gauntlet
  mode: shell
  command: agent-gauntlet run
  continue_on_failure: true
```

Essential for the verify-fix pattern where gauntlet failure is expected and handled by the next step.

### skip_if

Skip a step based on the previous step's outcome:

```yaml
- id: fix
  mode: headless
  session: resume
  prompt: "Fix the issues..."
  skip_if: previous_success
```

When `skip_if: previous_success` is set, the step is skipped if the previous step succeeded. This pairs with `continue_on_failure` to create conditional execution: run the fix step only when the gauntlet fails.

## Output capture

Shell steps can capture their stdout into a named variable:

```yaml
- id: gauntlet
  mode: shell
  command: agent-gauntlet run
  capture: gauntlet_output
  continue_on_failure: true

- id: fix
  mode: headless
  prompt: |
    Fix these issues:
    {{gauntlet_output}}
  skip_if: previous_success
```

The captured output is both displayed to the terminal (tee behavior) and stored in the variable. Captured variables are available to all subsequent steps via `{{var_name}}` interpolation and are persisted in the state file for resume.

## Running workflows

### Basic run

```bash
baton run workflows/flokay.yaml my-change
```

### Starting from a specific step

```bash
baton run workflows/flokay.yaml my-change --from design
```

Skips all steps before `design` and starts there. Useful when you've already completed earlier steps manually or want to re-run a specific phase.

### Resuming interrupted workflows

If a workflow is interrupted (you abort, a step fails, your machine restarts), baton saves its state to `baton-state.json`. Resume with:

```bash
baton resume path/to/baton-state.json
```

This reloads the workflow, restores session IDs and parameters, and picks up from the last step. If the workflow file has changed since the state was written, baton warns you but proceeds.

The state file location depends on the engine. The openspec engine stores it in the change directory (`openspec/changes/<name>/baton-state.json`). Without an engine, it's in the project root.

### Validating workflows

Check that a workflow is syntactically valid without running it:

```bash
baton validate workflows/flokay.yaml
```

With an engine configured, this also runs engine-specific validation (e.g., checking that every openspec artifact has a matching workflow step).

## Engines

Engines are optional plugins that hook into baton's execution lifecycle. They enrich prompts with external context, validate that steps produced expected output, and control where state files live.

### The openspec engine

The built-in openspec engine integrates with the OpenSpec CLI. It:

1. **Enriches prompts** -- Before each artifact step, calls `openspec instructions` to get the template, output path, and dependencies, and appends them to the prompt in an `<artifact_context>` block.

2. **Validates steps** -- After each artifact step, calls `openspec status` to check that the artifact was created. If validation fails, baton offers you the choice to resume the session interactively or exit.

3. **Validates the workflow** -- At load time, checks that every openspec schema artifact has a matching step ID in the workflow.

4. **Controls state directory** -- Places `baton-state.json` in the openspec change directory.

#### Configuration

```yaml
engine:
  type: openspec
  change_param: change_name    # which workflow param holds the change name
```

The engine uses the step ID to determine which steps are artifact steps. Step IDs must match the openspec schema's artifact IDs exactly (e.g., `proposal`, `specs`, `design`, `tasks`, `review`).

#### Requirements

The `openspec` CLI must be installed and on your PATH. The engine checks for this at initialization and fails fast with a clear error if it's missing.

### Writing custom engines

Engines implement the `Engine` interface (all methods optional):

```typescript
interface Engine {
  getStateDir?(params: Record<string, string>): string;
  validateWorkflow?(workflow: Workflow, params: Record<string, string>): void;
  enrichPrompt?(stepId: string, params: Record<string, string>): string | undefined;
  validateStep?(stepId: string, params: Record<string, string>): boolean;
}
```

Register your engine in `src/engine.ts`:

```typescript
import { myEngine } from './engines/my-engine.ts';

const engineRegistry: Record<string, EngineConstructor> = {
  openspec: createOpenSpecEngine,
  'my-engine': myEngine,
};
```

## The flokay workflow

The flokay workflow (`workflows/flokay.yaml`) orchestrates the full change lifecycle using composition. It calls into sub-workflows for the implementation phase:

| Step | Type | What it does |
|------|------|-------------|
| `create` | shell | Scaffolds a new openspec change |
| `proposal` | interactive | Collaboratively write the proposal |
| `specs` | interactive (resume) | Write specs based on the proposal |
| `design` | interactive | Design the architecture |
| `tasks` | headless | Generate implementation tasks |
| `review` | headless (resume) | Run gauntlet review |
| `implement` | sub-workflow | Loops over task files, implements each with gauntlet retry |
| `verify` | headless | Verify implementation with gauntlet |
| `archive` | headless (resume) | Archive the change, sync specs |
| `archive-verify` | shell | Skip gauntlet for archive-only changes |
| `finalize` | headless (resume) | Push PR, wait for CI, fix failures |

The `implement` step invokes `workflows/implement-change.yaml`, which loops over task files and for each one invokes `workflows/implement-task.yaml`, which itself invokes `workflows/run-gauntlet.yaml` for the verify-fix retry loop.

Run it:

```bash
baton run workflows/flokay.yaml my-feature-name
```

## Troubleshooting

### "Missing required parameter"

You forgot to pass a required parameter. Check the workflow's `params` section and pass values as positional arguments.

### "Step not found in workflow"

The `--from` step ID doesn't match any step in the workflow. Check `baton validate` output for the list of step IDs.

### "Unknown engine type"

The engine type in the workflow doesn't match any registered engine. Currently only `openspec` is built-in.

### "openspec CLI not found"

The openspec engine requires the `openspec` CLI on your PATH. Install it and try again.

### Interactive step won't advance

Make sure `/continue` is available as a skill. Baton's Claude Code plugin must be installed for this to work. If it's not available, you can manually create the signal file:

```bash
echo '{"action":"continue"}' > .baton-signal
```

### Workflow interrupted, how to resume

Find the `baton-state.json` file (in the project root or the engine's state directory) and run:

```bash
baton resume baton-state.json
```
