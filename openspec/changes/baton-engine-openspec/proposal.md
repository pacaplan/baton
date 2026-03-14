## Why

Baton invokes flokay skills directly (e.g., `/flokay:propose`), bypassing the openspec instructions layer. The flokay skills expect template content, output paths, and dependency info to be "provided" to them — language like "to the outputPath provided, using the template structure provided." When `opsx:continue` orchestrates, it calls `openspec instructions` first and injects all of this. When baton orchestrates, none of it is provided. It works by accident (Claude searches the project and finds the template), but it's fragile and lossy.

Additionally, when resuming a partially-completed workflow, baton requires the user to pass `--from <step-id>` manually. OpenSpec already tracks artifact completion state and can determine the next step programmatically.

## What Changes

- Add an **engine** abstraction to baton that pluggable modules can implement
- Implement an **openspec engine** that calls `openspec status` and `openspec instructions` to enrich baton's workflow execution
- Engine **resolves the start step** automatically by querying artifact completion state, eliminating the need for `--from` in engine-backed workflows
- Engine **enriches prompts** by prepending template content, output path, and dependency info before passing to Claude
- Engine **validates step completion** by checking that the expected artifact file exists after each step finishes
- Workflow files gain an `engine` block and steps gain an optional `artifact` field to map steps to openspec artifact IDs

## Capabilities

### New Capabilities

- `engine-interface`: The pluggable engine abstraction — interface definition, engine loading from workflow config, integration into the runner lifecycle (resolve start step, enrich prompt, validate step)
- `openspec-engine`: The openspec-specific engine implementation — calls `openspec status` and `openspec instructions` CLI commands, parses JSON output, maps artifact IDs to workflow steps, enriches prompts with template/outputPath/dependencies, validates artifact files exist after steps complete
- `workflow-engine-config`: Schema and workflow file changes — `engine` block on workflows, `artifact` field on steps, validation that artifact-mapped steps exist when an engine is configured

### Modified Capabilities

_(none — baton has no existing specs)_

## Impact

- **`src/schema.ts`** — Add `engine` and `artifact` fields to workflow/step schemas
- **`src/runner.ts`** — Call engine methods during workflow execution (resolve start, enrich prompt, validate step)
- **New `src/engine.ts`** — Engine interface definition and loader
- **New `src/engines/openspec.ts`** — OpenSpec engine implementation
- **`workflows/flokay.yaml`** — Add engine config and artifact mappings to steps
- **Runtime dependency** — Requires `openspec` CLI to be installed when using the openspec engine
