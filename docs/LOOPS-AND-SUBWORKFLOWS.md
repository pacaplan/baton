# Loops and Sub-Workflows: Proposal Draft

> Temporary working document. Will be replaced by an OpenSpec proposal once we begin the change.

## Motivation

Baton currently executes workflows as a linear sequence of steps. This works well for the flokay change lifecycle (propose, spec, design, implement, verify, finalize) where each step runs once in order.

But the implementation and verification phases are inherently iterative:

1. **Task loop**: For each task in a change, run an implement-and-verify cycle.
2. **Verify-fix loop**: After implementation, run the gauntlet. If it fails, feed the failures back to the same session that implemented the code (it has all the context), then re-run the gauntlet. Repeat up to 3 times.

Today, these loops live inside agent skills (`flokay:implement-task` and `gauntlet-run`). The agent orchestrates its own retry logic, which violates baton's core thesis: **agents are good at execution, bad at orchestration**. Moving these loops into baton makes them deterministic, visible, and debuggable.

For context see:
/Users/pcaplan/paul/flokay/skills/implement-task/SKILL.md
/Users/pcaplan/paul/agent-gauntlet/skills/gauntlet-run/SKILL.md

## Target Architecture

```
┌─ OUTER LOOP (per task) ──────────────────────────────────────────┐
│                                                                   │
│  for each task_file in tasks/*.task.md:                           │
│                                                                   │
│    ┌─ implement (headless, new session) ──────────────────────┐  │
│    │  "Read the task file and implement with TDD"              │  │
│    └───────────────────────────────────────────────────────────┘  │
│                          │                                        │
│                          ▼                                        │
│    ┌─ INNER LOOP (verify-fix, max 3) ────────────────────────┐  │
│    │                                                          │  │
│    │   ┌─ gauntlet (shell) ──────────────┐                   │  │
│    │   │  agent-gauntlet run             │──── pass? ──→ BREAK│  │
│    │   └─────────────────────────────────┘         │         │  │
│    │                                          fail │         │  │
│    │                                               ▼         │  │
│    │   ┌─ fix (headless, RESUME implement) ──────┐          │  │
│    │   │  "Here are the failures, fix them"       │          │  │
│    │   └──────────────────────────────────────────┘          │  │
│    │                    │                                     │  │
│    │                    └──────── loop back ─────────────────┘  │
│    └──────────────────────────────────────────────────────────┘  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

The critical property: `fix` resumes the `implement` session. The agent that wrote the code has all the context needed to fix gauntlet failures. Across loop iterations, sessions chain naturally: `implement → fix₁ → fix₂ → fix₃`, accumulating knowledge with each attempt.

When the outer loop moves to the next task, `implement` starts a fresh session — clean slate for a new task.

## New Primitives

Six new capabilities added to the workflow schema:

### 1. `loop` — Repeat a group of steps

Two flavors:

**Counted loop (repeat up to N times):**
```yaml
- id: verify-fix
  loop: { max: 3 }
  steps:
    - id: gauntlet
      mode: shell
      command: agent-gauntlet run
```

**For-each loop (iterate over a list):**
```yaml
- id: per-task
  loop:
    over: "openspec/changes/{{change_name}}/tasks/*.task.md"
    as: task_file
  steps:
    - id: implement
      mode: headless
      prompt: "Implement {{task_file}}"
```

The `over` field accepts a glob pattern, expanded at runtime. Each match is bound to the variable named in `as`, available via `{{task_file}}` interpolation in nested steps.

### 2. `steps` (nested) — Inline step groups

Steps can contain child steps, creating logical groups. Required for loops (the loop body is a `steps` array) but also useful for organizing workflows without control flow.

```yaml
- id: verify-fix
  loop: { max: 3 }
  steps:    # <-- nested steps
    - id: gauntlet
      mode: shell
      command: agent-gauntlet run
    - id: fix
      mode: headless
      session: resume
      prompt: "Fix these: {{gauntlet_output}}"
```

Nested steps inherit the parent's parameter scope and have access to captured variables from sibling steps.

### 3. `workflow` — Sub-workflow invocation

A step can invoke another workflow file instead of running a command or agent directly:

```yaml
- id: verify
  workflow: workflows/verify-fix.yaml
  params:
    task_file: "{{task_file}}"
```

Sub-workflows execute in the same process, sharing session state with the parent. Parameters are passed explicitly via the `params` map. This enables composition — complex patterns are extracted into reusable workflow files.

### 4. `capture` — Capture shell stdout into a variable

Shell steps can capture their stdout into a named variable, available to subsequent steps:

```yaml
- id: gauntlet
  mode: shell
  command: agent-gauntlet run
  capture: gauntlet_output
```

After this step, `{{gauntlet_output}}` expands to the captured stdout in any subsequent step's prompt or command. Output is both captured and displayed to the terminal (tee behavior).

Implementation: the runner pipes stdout through a buffer while also streaming to the terminal. The captured content is stored in the run state alongside session IDs.

### 5. `continue_on_failure` — Don't halt on step failure

By default, a failed step stops the workflow. `continue_on_failure: true` allows the workflow to proceed, which is essential for the verify-fix pattern where gauntlet failure is expected and handled by the next step.

```yaml
- id: gauntlet
  mode: shell
  command: agent-gauntlet run
  capture: gauntlet_output
  continue_on_failure: true
```

The step's exit code is tracked and available for conditions. The workflow only stops if the step fails *and* `continue_on_failure` is not set.

### 6. `break_if` — Exit a loop early

Controls when to break out of a loop. Applied to individual steps within a loop body:

```yaml
- id: gauntlet
  mode: shell
  command: agent-gauntlet run
  break_if: success    # exit loop when gauntlet passes
```

Evaluated after the step executes. `break_if: success` exits the enclosing loop if the step succeeded (exit code 0). `break_if: failure` exits on non-zero. When triggered, execution continues with the next step after the loop.

## What the YAML Looks Like

### Single-file approach (inline nesting)

```yaml
name: implement-change
description: "Implement all tasks with gauntlet verification"
params:
  - name: change_name

steps:
  - id: per-task
    loop:
      over: "openspec/changes/{{change_name}}/tasks/*.task.md"
      as: task_file
    steps:
      - id: implement
        mode: headless
        prompt: |
          Read the task file at {{task_file}} and implement it.
          Write tests first, then implementation.

      - id: verify-fix
        loop: { max: 3 }
        steps:
          - id: gauntlet
            mode: shell
            command: agent-gauntlet run
            capture: gauntlet_output
            continue_on_failure: true
            break_if: success

          - id: fix
            mode: headless
            session: resume
            prompt: |
              The gauntlet found issues. Here are the failures:

              {{gauntlet_output}}

              Fix these issues.
```

### Composed approach (sub-workflows)

**workflows/verify-fix.yaml:**
```yaml
name: verify-fix
description: "Run gauntlet and fix failures"

steps:
  - id: gauntlet
    mode: shell
    command: agent-gauntlet run
    capture: gauntlet_output
    continue_on_failure: true
    break_if: success

  - id: fix
    mode: headless
    session: resume
    prompt: |
      The gauntlet found issues:
      {{gauntlet_output}}
      Fix them.
```

**workflows/implement-change.yaml:**
```yaml
name: implement-change
params:
  - name: change_name

steps:
  - id: per-task
    loop:
      over: "openspec/changes/{{change_name}}/tasks/*.task.md"
      as: task_file
    steps:
      - id: implement
        mode: headless
        prompt: "Read {{task_file}} and implement with TDD"

      - id: verify
        workflow: workflows/verify-fix.yaml
        loop: { max: 3 }
```

Both approaches are valid. Inline for simple cases, sub-workflows for reusable patterns.

## Session Behavior Inside Loops

Session management works naturally with loops because of baton's existing "resume = continue last session" semantics.

**Inner loop (verify-fix), single task:**
```
Iteration 1:
  gauntlet   →  shell (no session)
  fix        →  resumes implement's session → creates session S1'

Iteration 2 (if gauntlet fails again):
  gauntlet   →  shell (no session)
  fix        →  resumes S1' → creates S1''

Iteration 3 (if still failing):
  gauntlet   →  shell (no session)
  fix        →  resumes S1'' → creates S1'''
```

Each fix builds on the previous context. The agent accumulates knowledge: original implementation, first fix attempt, second fix attempt.

**Outer loop (per task), across tasks:**
```
Task 1:
  implement  →  session S1 (new)
  [verify-fix loop uses S1, S1', S1'']

Task 2:
  implement  →  session S2 (new)     ← fresh start
  [verify-fix loop uses S2, S2', S2'']
```

`session: new` on `implement` resets for each task. Clean separation between tasks.

## Loop Exhaustion

When a counted loop reaches its max iterations without a `break_if` triggering, the default behavior is to **fail the workflow**. This is configurable:

```yaml
- id: verify-fix
  loop:
    max: 3
    on_exhaust: fail    # default — stop the workflow
```

Other possible values (to be evaluated during implementation):
- `continue` — skip to the next step after the loop
- `ask` — prompt the user for a decision

For the gauntlet use case, `fail` is correct: if 3 fix attempts didn't resolve the issues, human intervention is needed.

## Design Influences

These primitives draw from established patterns in existing workflow systems:

| Primitive | Primary influence | Pattern borrowed |
|---|---|---|
| `loop: { max: N }` | Azure Logic Apps `Until`, Netflix Conductor `DO_WHILE` | Counted loop with max iterations |
| `loop: { over, as }` | Kestra `ForEach`, CNCF Serverless Workflow `for:` | For-each with item binding |
| `capture` | Argo Workflows `outputs.parameters`, Serverless Workflow `output:` | Stdout capture into named variable |
| `break_if` | CNCF Serverless Workflow `while:` guard (inverted) | Loop exit condition |
| `continue_on_failure` | GitHub Actions `continue-on-error` | Step failure tolerance |
| `workflow` (sub-workflows) | Kestra `Subflow`, Serverless Workflow `run: workflow:` | Workflow composition |

The specific systems most worth studying for implementation details:

1. **CNCF Serverless Workflow Specification (1.0)** — The most complete declarative workflow DSL. Its `for:` / `do:` / `run: shell:` task types, `output:` capture, and JQ-based data flow are the gold standard for how these primitives should feel.

2. **Kestra** — The most practical YAML-first orchestration platform. Its `ForEach`, `LoopUntil`, `If/else`, shell task types, and output variable system are directly applicable. Kestra is server-based (not CLI), but its YAML patterns are clean and battle-tested.

3. **Argo Workflows** — Kubernetes-native but has excellent patterns for `withParam` dynamic loops (looping over output from a previous step), `when:` conditionals, and template composition.

4. **Taskfile (go-task)** — The closest CLI-native tool. Its `for:` loops over globs and shell-output variables (`sh:`) are the most relevant for baton's local-execution model. Where Taskfile breaks down (no loop-until, no mid-pipeline capture, no conditional branching) is exactly where baton's new primitives add value.

## Implementation Scope

Changes required in the baton codebase:

**Schema (`src/schema.ts`):**
- New optional fields on `StepSchema`: `steps`, `workflow`, `loop`, `capture`, `continue_on_failure`, `break_if`
- New `LoopSchema` with `max`, `over`, `as`, `on_exhaust` fields
- Recursive step validation (steps containing steps)

**Runner (`src/runner.ts`):**
- `executeStep` becomes recursive — can handle nested steps and sub-workflows
- New `executeLoop` function for counted and for-each loops
- New `executeSubWorkflow` function for workflow composition
- Output capture mechanism (tee stdout to buffer + terminal)
- Step result tracking (exit codes, captured variables in state)
- `break_if` evaluation after step execution
- `continue_on_failure` handling in the step failure path

**Loader (`src/loader.ts`):**
- Extended interpolation to include captured variables: `{{gauntlet_output}}`
- Glob expansion for `loop.over` patterns

**State (`src/state.ts`):**
- Captured variables stored alongside session IDs
- Nested loop state tracking (current iteration, loop variables)

Estimated complexity: the runner goes from ~380 lines to ~550-700 lines. The schema adds ~30 lines. The loader adds ~20 lines.

### Addendum

The above was written by claude based on conversation. This addendum is added by the human, Paul. I want the state tracking (baton-state.json) to be recursive. So if we're in the middle of a nested workflow inside of a nested workflow, i want the state file to capture the current state of each.
My suggestion (but open to other ideas) is is that the "currentStep" attribute can have an id (string) and a nested (recursive) workflow json that has its own steps, etc.

Also, I want the flokay workflow to have two steps: plan and implement. Each of these is its own workflow, as described in /Users/pcaplan/paul/flokay/docs/guide.md . So it will be turtles all the way down (although I'm probably not using that expression correctly).