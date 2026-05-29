import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export type SupportedWorkspaceManager = 'pnpm';
export type DetectedWorkspaceManager = SupportedWorkspaceManager | 'npm' | 'yarn' | 'bun';

export async function detectWorkspaceManager(workspacePath: string): Promise<DetectedWorkspaceManager | undefined> {
  const packageJson = await readOptionalJson(path.join(workspacePath, 'package.json'));
  const packageManager = readPackageManager(packageJson);
  if (packageManager) {
    return packageManager;
  }

  if (await exists(path.join(workspacePath, 'pnpm-workspace.yaml'))
    || await exists(path.join(workspacePath, 'pnpm-workspace.yml'))
    || await exists(path.join(workspacePath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  if (await exists(path.join(workspacePath, 'package-lock.json'))) {
    return 'npm';
  }
  if (await exists(path.join(workspacePath, 'yarn.lock'))) {
    return 'yarn';
  }
  if (await exists(path.join(workspacePath, 'bun.lock')) || await exists(path.join(workspacePath, 'bun.lockb'))) {
    return 'bun';
  }

  return undefined;
}

async function readOptionalJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function readPackageManager(packageJson: unknown): DetectedWorkspaceManager | undefined {
  if (!isRecord(packageJson) || typeof packageJson.packageManager !== 'string') {
    return undefined;
  }
  return packageJson.packageManager.split('@')[0] as DetectedWorkspaceManager;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
