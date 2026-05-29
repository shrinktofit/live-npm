import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import type { CatalogRewriteConfig } from './config.js';
import { readManifest } from './package-plan.js';
import type { WorkspaceDriver, WorkspacePackage } from './workspace-driver.js';

interface PnpmListPackage {
  name?: string;
  path?: string;
  version?: string;
}

export const pnpmWorkspaceDriver: WorkspaceDriver = {
  name: 'pnpm',

  async listPackages(workspacePath) {
    return await listWorkspacePackages(workspacePath);
  },

  async readCatalogs(workspacePath) {
    return await readPnpmWorkspaceCatalogs(workspacePath);
  },

  async readMetadataPaths(workspacePath) {
    return await readWorkspaceMetadataPaths(workspacePath);
  },
};

async function listWorkspacePackages(workspacePath: string): Promise<WorkspacePackage[]> {
  const args = ['list', '-r', '--depth', '-1', '--json'];

  const rawPackages = await runPnpmJson<PnpmListPackage[]>(workspacePath, args);
  const workspacePackages: WorkspacePackage[] = [];

  for (const rawPackage of rawPackages) {
    if (!rawPackage.name || !rawPackage.path) {
      continue;
    }

    const manifest = await readManifest(rawPackage.path);
    const version = typeof manifest.version === 'string' ? manifest.version : rawPackage.version;
    workspacePackages.push({
      manifest,
      name: rawPackage.name,
      path: rawPackage.path,
      ...(version ? { version } : {}),
    });
  }

  return workspacePackages;
}

async function readPnpmWorkspaceCatalogs(workspacePath: string): Promise<CatalogRewriteConfig> {
  const workspaceFile = await findFirstExisting([
    path.join(workspacePath, 'pnpm-workspace.yaml'),
    path.join(workspacePath, 'pnpm-workspace.yml'),
  ]);
  if (!workspaceFile) {
    return { default: {}, named: {} };
  }

  const data = parse(await readFile(workspaceFile, 'utf8')) as unknown;
  if (!isRecord(data)) {
    return { default: {}, named: {} };
  }

  return {
    default: readCatalog(data.catalog),
    named: readNamedCatalogs(data.catalogs),
  };
}

async function readWorkspaceMetadataPaths(workspacePath: string): Promise<string[]> {
  const paths = [
    path.join(workspacePath, 'package.json'),
    path.join(workspacePath, 'pnpm-workspace.yaml'),
    path.join(workspacePath, 'pnpm-workspace.yml'),
    path.join(workspacePath, 'pnpm-lock.yaml'),
  ];
  const existingPaths = await Promise.all(paths.map(async (metadataPath) => {
    if (await exists(metadataPath)) {
      return metadataPath;
    }
    return undefined;
  }));
  return existingPaths.filter((metadataPath) => metadataPath !== undefined);
}

async function runPnpmJson<T>(workspacePath: string, args: string[]): Promise<T> {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return new Promise((resolve, reject) => {
    execFile(command, ['--dir', workspacePath, ...args], {
      cwd: workspacePath,
      maxBuffer: 1024 * 1024 * 20,
      shell: process.platform === 'win32',
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`pnpm ${args.join(' ')} failed in ${workspacePath}.\n${stderr || error.message}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout || '[]') as T);
      } catch (parseError) {
        reject(new Error(`pnpm ${args.join(' ')} returned invalid JSON: ${String(parseError)}`));
      }
    });
  });
}

function readCatalog(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function readNamedCatalogs(value: unknown): Record<string, Record<string, string>> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([catalogName, catalog]) => [catalogName, readCatalog(catalog)]),
  );
}

async function findFirstExisting(paths: string[]): Promise<string | undefined> {
  for (const file of paths) {
    if (await exists(file)) {
      return file;
    }
  }
  return undefined;
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
