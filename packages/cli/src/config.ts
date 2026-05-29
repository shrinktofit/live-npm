import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

export interface LiveNpmConfig {
  debounceMs: number;
  packages: LiveNpmPackageConfig[];
  workspaces: LiveNpmWorkspaceConfig[];
}

export interface LiveNpmPackageConfig {
  extraWatchPaths?: string[];
  manifestRewrite?: ManifestRewriteConfig;
  source: string;
}

export interface LiveNpmWorkspaceConfig {
  includes: string[];
  path: string;
}

export interface ManifestRewriteConfig {
  catalogs: CatalogRewriteConfig;
  liveDependencyNames?: string[];
  workspaceVersions: Record<string, string>;
}

export interface CatalogRewriteConfig {
  default: Record<string, string>;
  named: Record<string, Record<string, string>>;
}

export async function loadConfig(configPath: string): Promise<LiveNpmConfig> {
  const resolvedConfigPath = path.resolve(configPath);
  const configDir = path.dirname(resolvedConfigPath);
  const raw = await readFile(resolvedConfigPath, 'utf8');
  const data = parse(raw) as unknown;

  if (!isRecord(data)) {
    throw new Error(`Config ${resolvedConfigPath} must be a YAML object.`);
  }

  const rawPackages = data.packages ?? [];
  const rawWorkspaces = data.workspaces ?? [];
  if (!Array.isArray(rawPackages)) {
    throw new Error(`Config ${resolvedConfigPath} packages must be an array.`);
  }
  if (!Array.isArray(rawWorkspaces)) {
    throw new Error(`Config ${resolvedConfigPath} workspaces must be an array.`);
  }
  if (rawPackages.length === 0 && rawWorkspaces.length === 0) {
    throw new Error(`Config ${resolvedConfigPath} must contain packages or workspaces.`);
  }

  const debounceMs = data.debounceMs === undefined ? 200 : readPositiveInteger(data.debounceMs, 'debounceMs');
  return {
    debounceMs,
    packages: rawPackages.map((item, index) => readPackageConfig(item, index, configDir)),
    workspaces: rawWorkspaces.map((item, index) => readWorkspaceConfig(item, index, configDir)),
  };
}

function readPackageConfig(data: unknown, index: number, configDir: string): LiveNpmPackageConfig {
  if (!isRecord(data)) {
    throw new Error(`packages[${index}] must be an object.`);
  }

  const source = readPath(data.source, `packages[${index}].source`, configDir);
  return { source };
}

function readWorkspaceConfig(data: unknown, index: number, configDir: string): LiveNpmWorkspaceConfig {
  if (!isRecord(data)) {
    throw new Error(`workspaces[${index}] must be an object.`);
  }

  const workspacePath = readPath(data.path, `workspaces[${index}].path`, configDir);
  const includes = readStringArray(data.includes, `workspaces[${index}].includes`);
  if (includes.length === 0) {
    throw new Error(`workspaces[${index}].includes must not be empty.`);
  }

  return { includes, path: workspacePath };
}

function readPath(value: unknown, label: string, baseDir: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return path.resolve(baseDir, value);
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
