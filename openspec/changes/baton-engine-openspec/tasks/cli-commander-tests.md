# Task: Migrate CLI to commander and add test coverage

## Goal

Replace baton's hand-rolled argument parsing with the `commander` npm package, reorganize into one file per command under `src/commands/`, and add unit test coverage for all existing code. Same behavior, cleaner structure, tested.

## Background

Baton currently has 4 source files with no tests:
- `src/index.ts` — CLI entry point with hand-rolled `parseArgs` function and a `main` function that dispatches to `run` or `validate`
- `src/schema.ts` — Zod schemas for `Step`, `Param`, and `Workflow`
- `src/loader.ts` — `loadWorkflow` (reads YAML, parses with Zod) and `interpolateParams` (replaces `{{param}}` placeholders)
- `src/runner.ts` — `runWorkflow` loop that executes steps by spawning `claude` or shell processes

The project uses Bun as its runtime and test runner (`bun test`). Tests go in `test/` (excluded from tsconfig compilation). Dependencies: `zod`, `yaml`. Dev: `@biomejs/biome`, `@types/bun`.

**What to do:**

1. Add `commander` as a dependency.
2. Create `src/commands/run.ts` — registers the `baton run <workflow> [params...]` command with `--from <step>` option. Extracts the workflow loading, param mapping, and `runWorkflow` call currently in `index.ts`.
3. Create `src/commands/validate.ts` — registers the `baton validate <workflow>` command. Extracts the validation logic currently in `index.ts`.
4. Create `src/commands/index.ts` — re-exports `registerRunCommand` and `registerValidateCommand`.
5. Rewrite `src/index.ts` — create a Commander program, register commands, parse `process.argv`. The `main` function and hand-rolled `parseArgs` are replaced entirely.
6. Add unit tests for all existing code:
   - `test/schema.test.ts` — Zod schema validation (valid workflows parse, invalid ones reject, defaults apply)
   - `test/loader.test.ts` — `loadWorkflow` with fixture YAML files, `interpolateParams` with valid/missing params
   - `test/runner.test.ts` — runner behavior with mocked process spawning (shell steps, agent steps, signal handling, session resume)

**Conventions:**
- Follow the commander pattern from agent-gauntlet: each command file exports a `register*Command(program: Command)` function
- Use `bun test` with `describe`/`it`/`expect` (Bun's built-in test API)
- Runner tests need to mock `Bun.spawn` since the runner spawns real processes

## Done When

- `baton run` and `baton validate` work identically to before
- `baton --help` shows usage with all commands
- `src/commands/` directory exists with one file per command
- All tests pass via `bun test`
- Test coverage exists for schema validation, loader, interpolation, and runner step execution
