import { dirname, join, resolve } from 'node:path';
import type { Engine } from '../engine.ts';
import { loadWorkflow } from '../loader.ts';
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
  schemaName: string;
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

function tryLoadArtifactIds(changeName: string): Set<string> | null {
  try {
    return loadArtifactIds(changeName);
  } catch (error) {
    // Change doesn't exist yet — skip validation (a workflow step may create it)
    if (error instanceof Error && /ENOENT|not found/i.test(error.message)) {
      return null;
    }
    throw new Error(
      `Failed to load OpenSpec artifacts for ${changeName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveTemplatePath(data: OpenSpecInstructionsOutput): string {
  return join(
    data.changeDir,
    '..',
    '..',
    'schemas',
    data.schemaName,
    'templates',
    `${data.artifactId}.md`,
  );
}

function buildEnrichmentBlock(data: OpenSpecInstructionsOutput): string {
  const outputPath = join(data.changeDir, data.outputPath);
  const templatePath = resolveTemplatePath(data);

  const lines = [
    `**Output path:** ${outputPath}`,
    `**Template:** ${templatePath}`,
  ];

  if (data.dependencies.length > 0) {
    lines.push('', '**Dependencies:**');
    for (const dep of data.dependencies) {
      const absPath = join(data.changeDir, dep.path);
      lines.push(`- ${absPath} — ${dep.description}`);
    }
  }

  lines.push(
    '',
    'Read the template file for the expected output structure. Write your output to the output path.',
  );

  return lines.join('\n');
}

/** Recursively collect step IDs from a workflow and its sub-workflows. */
function collectAllStepIds(
  workflow: Workflow,
  workflowFile?: string,
  visited: Set<string> = new Set(),
): Set<string> {
  const ids = new Set<string>();
  for (const step of workflow.steps) {
    ids.add(step.id);
    if (step.workflow && workflowFile && !step.workflow.includes('{{')) {
      const parentDir = dirname(workflowFile);
      const subPath = resolve(parentDir, step.workflow);
      if (visited.has(subPath)) {
        throw new Error(`Circular sub-workflow reference detected: ${subPath}`);
      }
      visited.add(subPath);
      try {
        const subWorkflow = loadWorkflow(subPath, { isSubWorkflow: true });
        for (const id of collectAllStepIds(subWorkflow, subPath, visited)) {
          ids.add(id);
        }
      } finally {
        visited.delete(subPath);
      }
    }
  }
  return ids;
}

function validateEngineConfig(config: Record<string, unknown>): string {
  const changeParam = config.change_param;
  if (typeof changeParam !== 'string' || !changeParam) {
    throw new Error('OpenSpec engine requires "change_param" in engine config');
  }
  if (!Bun.which('openspec')) {
    throw new Error(
      'openspec CLI not found. Ensure "openspec" is installed and on your PATH.',
    );
  }
  return changeParam;
}

export function createOpenSpecEngine(config: Record<string, unknown>): Engine {
  const changeParam = validateEngineConfig(config);

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

    validateWorkflow(
      workflow: Workflow,
      params: Record<string, string>,
      workflowFile?: string,
    ): void {
      const changeName = getChangeName(changeParam, params);
      artifactIds = tryLoadArtifactIds(changeName);
      if (!artifactIds) return;

      const stepIds = collectAllStepIds(workflow, workflowFile);
      const unmatched = [...artifactIds].filter((id) => !stepIds.has(id));

      if (unmatched.length > 0) {
        throw new Error(
          `Workflow is missing steps for openspec artifacts: ${unmatched.join(', ')}`,
        );
      }
    },

    needsDeferredValidation(): boolean {
      return artifactIds === null;
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
