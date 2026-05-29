import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Arborist from '@npmcli/arborist';
import packlist from 'npm-packlist';

export interface PackageManifest {
  dependencies?: unknown;
  devDependencies?: unknown;
  name?: string;
  files?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  version?: string;
  [key: string]: unknown;
}

export interface PublishPlan {
  files: string[];
  manifest: PackageManifest;
  packageName: string;
  source: string;
  target: string;
}

export async function createPublishPlan(source: string, target: string): Promise<PublishPlan> {
  const manifest = await readManifest(source);
  const packageName = readPackageName(manifest, source);
  const arborist = new Arborist({ path: source });
  const tree = await arborist.loadActual();
  const files = normalizePacklist(await packlist(tree));

  return {
    files,
    manifest,
    packageName,
    source,
    target,
  };
}

export async function readManifest(source: string): Promise<PackageManifest> {
  const manifestPath = path.join(source, 'package.json');
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as PackageManifest;
}

export function getWatchPaths(source: string, manifest: PackageManifest): string[] {
  const files = readFilesField(manifest);
  const watchPaths: string[] = [];
  const resolvedSource = path.resolve(source);
  const addWatchPath = (watchPath: string) => {
    addFoldedWatchPath(watchPaths, watchPath);
  };

  addWatchPath(path.join(resolvedSource, 'package.json'));

  if (files) {
    let hasPositiveWatchPath = false;
    for (const entry of files) {
      const watchPath = watchPathFromFilesEntry(resolvedSource, entry);
      if (!watchPath) {
        continue;
      }
      hasPositiveWatchPath = true;
      addWatchPath(watchPath);
    }
    if (!hasPositiveWatchPath) {
      addWatchPath(resolvedSource);
    }
  } else {
    addWatchPath(resolvedSource);
  }

  for (const defaultFile of [
    '.gitignore',
    '.npmignore',
    'README',
    'README.md',
    'LICENSE',
    'LICENSE.md',
    'LICENCE',
    'LICENCE.md',
    'NOTICE',
  ]) {
    addWatchPath(path.join(resolvedSource, defaultFile));
  }

  return watchPaths;
}

function readPackageName(manifest: PackageManifest, source: string): string {
  if (typeof manifest.name === 'string' && manifest.name.length > 0) {
    return manifest.name;
  }
  return source;
}

function readFilesField(manifest: PackageManifest): string[] | undefined {
  if (!Array.isArray(manifest.files) || !manifest.files.every((entry) => typeof entry === 'string')) {
    return undefined;
  }
  return manifest.files;
}

function normalizePacklist(files: string[]): string[] {
  return [...new Set(files.map((file) => file.replace(/\\/g, '/')))].sort();
}

function watchPathFromFilesEntry(source: string, entry: string): string | undefined {
  const normalizedEntry = normalizeFilesEntry(entry);
  if (!normalizedEntry || normalizedEntry.startsWith('!')) {
    return undefined;
  }

  const stableParts: string[] = [];
  for (const part of normalizedEntry.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      return source;
    }
    if (hasGlobToken(part)) {
      break;
    }
    stableParts.push(part);
  }

  const candidate = stableParts.length === 0
    ? source
    : path.join(source, ...stableParts);
  if (!isInsideOrSame(source, candidate)) {
    return source;
  }

  return nearestExistingPath(source, candidate);
}

function normalizeFilesEntry(entry: string): string {
  let normalized = entry.replace(/\\/g, '/');
  while (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function hasGlobToken(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[') || value.includes('{');
}

function nearestExistingPath(source: string, target: string): string {
  let current = path.resolve(target);
  const resolvedSource = path.resolve(source);

  while (isInsideOrSame(resolvedSource, current)) {
    if (existsSync(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return resolvedSource;
}

function addFoldedWatchPath(paths: string[], watchPath: string): void {
  const resolvedWatchPath = path.resolve(watchPath);

  for (const existing of paths) {
    if (isInsideOrSame(existing, resolvedWatchPath)) {
      return;
    }
  }

  for (let index = paths.length - 1; index >= 0; index -= 1) {
    if (isInsideOrSame(resolvedWatchPath, paths[index])) {
      paths.splice(index, 1);
    }
  }

  paths.push(resolvedWatchPath);
}

function isInsideOrSame(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
