import { join } from 'node:path';
import type { Engine } from '../engine.ts';
import type { Workflow } from '../schema.ts';

interface OpenSpecArtifact {
  id: string;
  status: string;
}

interface OpenSpecStatusOutput {
  changeName: string;
  changeDir: string;
  artifacts: OpenSpecArtifact[];
}

interface OpenSpecDependency {
  path: string;
  description: string;
}

interface OpenSpecInstructionsOutput {
  artifactId: string;
  instruction: string;
  outputPath: string;
  template: string;
  dependencies: OpenSpecDependency[];
  changeDir: string;
}

function runOpenSpecCmd(args: string[]): string {
  const result = Bun.spawnSync(['openspec', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      stderr || `openspec command failed with exit code ${result.exitCode}`,
    );
  }

  return result.stdout.toString().trim();
}

function getChangeName(
  changeParam: string,
  params: Record<string, string>,
): string {
  const name = params[changeParam];
  if (!name) {
    throw new Error(
      `Missing required param "${changeParam}" for openspec engine`,
    );
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(
      `Invalid change name "${name}": must not contain path separators or traversal`,
    );
  }
  return name;
}

function loadArtifactIds(changeName: string): Set<string> {
  const raw = runOpenSpecCmd(['status', '--change', changeName, '--json']);
  const status: OpenSpecStatusOutput = JSON.parse(raw);
  return new Set(status.artifacts.map((a) => a.id));
}

function buildEnrichmentBlock(data: OpenSpecInstructionsOutput): string {
  const outputPath = join(data.changeDir, data.outputPath);

  const depLines = data.dependencies.map((dep) => {
    const absPath = join(data.changeDir, dep.path);
    return `- ${absPath}: ${dep.description}`;
  });

  return [
    '<artifact_context>',
    '<output_path>',
    outputPath,
    '</output_path>',
    '<dependencies>',
    ...depLines,
    '</dependencies>',
    '<template>',
    data.template,
    '</template>',
    '</artifact_context>',
  ].join('\n');
}

export function createOpenSpecEngine(config: Record<string, unknown>): Engine {
  const changeParam = config.change_param;
  if (typeof changeParam !== 'string' || !changeParam) {
    throw new Error('OpenSpec engine requires "change_param" in engine config');
  }

  // Verify openspec CLI is available
  if (!Bun.which('openspec')) {
    throw new Error(
      'openspec CLI not found. Ensure "openspec" is installed and on your PATH.',
    );
  }

  // Artifact ID set — populated lazily when params become available
  let artifactIds: Set<string> | null = null;

  function ensureArtifactIds(changeName: string): Set<string> {
    if (!artifactIds) {
      artifactIds = loadArtifactIds(changeName);
    }
    return artifactIds;
  }

  return {
    getStateDir(params: Record<string, string>): string {
      const changeName = getChangeName(changeParam, params);
      return `openspec/changes/${changeName}/`;
    },

    validateWorkflow(workflow: Workflow, params: Record<string, string>): void {
      const changeName = getChangeName(changeParam, params);
      artifactIds = loadArtifactIds(changeName);

      const stepIds = new Set(workflow.steps.map((s) => s.id));
      const unmatched = [...artifactIds].filter((id) => !stepIds.has(id));

      if (unmatched.length > 0) {
        throw new Error(
          `Workflow is missing steps for openspec artifacts: ${unmatched.join(', ')}`,
        );
      }
    },

    enrichPrompt(
      stepId: string,
      params: Record<string, string>,
    ): string | undefined {
      const changeName = getChangeName(changeParam, params);
      const ids = ensureArtifactIds(changeName);

      if (!ids.has(stepId)) {
        return undefined;
      }

      const raw = runOpenSpecCmd([
        'instructions',
        stepId,
        '--change',
        changeName,
        '--json',
      ]);
      const data: OpenSpecInstructionsOutput = JSON.parse(raw);
      return buildEnrichmentBlock(data);
    },

    validateStep(stepId: string, params: Record<string, string>): boolean {
      const changeName = getChangeName(changeParam, params);
      const ids = ensureArtifactIds(changeName);

      if (!ids.has(stepId)) {
        return true;
      }

      const raw = runOpenSpecCmd(['status', '--change', changeName, '--json']);
      const status: OpenSpecStatusOutput = JSON.parse(raw);
      const artifact = status.artifacts.find((a) => a.id === stepId);

      if (!artifact) {
        return false;
      }

      return artifact.status === 'done';
    },
  };
}
