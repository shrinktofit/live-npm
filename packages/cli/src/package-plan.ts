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

export type WatchIgnoredPredicate = (watchPath: string) => boolean;

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
  for (const entry of readAlwaysIncludedManifestEntries(manifest)) {
    const watchPath = watchPathFromManifestEntry(resolvedSource, entry);
    if (watchPath) {
      addWatchPath(watchPath);
    }
  }

  if (files) {
    for (const entry of files) {
      const watchPath = watchPathFromFilesEntry(resolvedSource, entry);
      if (!watchPath) {
        continue;
      }
      addWatchPath(watchPath);
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

export function createPublishWatchIgnored(source: string, manifest: PackageManifest): WatchIgnoredPredicate {
  const resolvedSource = path.resolve(source);
  const files = readFilesField(manifest);

  return (watchPath) => {
    const relativePath = toPackageRelativePath(resolvedSource, watchPath);
    if (relativePath === undefined || relativePath === '') {
      return false;
    }

    if (isNeverIncludedRelativePath(relativePath)) {
      return true;
    }
    if (isAlwaysIncludedRelativePath(relativePath, manifest)) {
      return false;
    }

    if (files && matchesAnyFilesEntry(files, relativePath, true)) {
      return true;
    }

    if (isDefaultIgnoredRelativePath(relativePath)) {
      return !files || !matchesAnyFilesEntry(files, relativePath, false);
    }

    return false;
  };
}

function watchPathFromFilesEntry(source: string, entry: string): string | undefined {
  const normalizedEntry = normalizeFilesEntry(entry);
  if (!normalizedEntry || normalizedEntry.startsWith('!')) {
    return undefined;
  }
  if (isNeverIncludedRelativePath(normalizedEntry)) {
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

function watchPathFromManifestEntry(source: string, entry: string): string | undefined {
  const normalizedEntry = normalizeFilesEntry(entry);
  if (!normalizedEntry || isNeverIncludedRelativePath(normalizedEntry)) {
    return undefined;
  }

  const candidate = path.join(source, ...normalizedEntry.split('/').filter(Boolean));
  if (!isInsideOrSame(source, candidate)) {
    return undefined;
  }
  return nearestExistingPath(source, candidate);
}

function readAlwaysIncludedManifestEntries(manifest: PackageManifest): string[] {
  const entries: string[] = [];
  if (typeof manifest.main === 'string' && manifest.main.trim() !== '') {
    entries.push(manifest.main);
  }

  const bin = manifest.bin;
  if (typeof bin === 'string' && bin.trim() !== '') {
    entries.push(bin);
  } else if (isRecord(bin)) {
    for (const value of Object.values(bin)) {
      if (typeof value === 'string' && value.trim() !== '') {
        entries.push(value);
      }
    }
  }

  return entries;
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

function toPackageRelativePath(source: string, watchPath: string): string | undefined {
  const relative = path.relative(source, path.resolve(watchPath));
  if (relative === '') {
    return '';
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, '/');
}

function isNeverIncludedRelativePath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '.git' || part === 'node_modules')) {
    return true;
  }

  return parts.some((part) => [
    '.npmrc',
    'bun.lockb',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
  ].includes(part));
}

function isDefaultIgnoredRelativePath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '.hg' || part === '.svn' || part === 'CVS')) {
    return true;
  }

  const basename = parts.at(-1) ?? '';
  return basename === '.DS_Store'
    || basename === '.lock-wscript'
    || basename === 'config.gypi'
    || basename === 'npm-debug.log'
    || basename.endsWith('.orig')
    || basename.startsWith('._')
    || basename.startsWith('.wafpickle-')
    || (basename.startsWith('.') && basename.endsWith('.swp'));
}

function isAlwaysIncludedRelativePath(relativePath: string, manifest: PackageManifest): boolean {
  if (relativePath === 'package.json') {
    return true;
  }

  const basename = relativePath.split('/').at(-1)?.toLowerCase() ?? '';
  if (basename === 'readme' || basename.startsWith('readme.')) {
    return true;
  }
  if (basename === 'license' || basename.startsWith('license.') || basename === 'licence' || basename.startsWith('licence.')) {
    return true;
  }

  return readAlwaysIncludedManifestEntries(manifest).some((entry) => normalizeFilesEntry(entry) === relativePath);
}

function matchesAnyFilesEntry(files: string[], relativePath: string, negative: boolean): boolean {
  return files.some((entry) => {
    const normalizedEntry = normalizeFilesEntry(entry);
    const isNegative = normalizedEntry.startsWith('!');
    if (isNegative !== negative) {
      return false;
    }

    const pattern = isNegative ? normalizedEntry.slice(1) : normalizedEntry;
    return matchesFilesPattern(pattern, relativePath);
  });
}

function matchesFilesPattern(pattern: string, relativePath: string): boolean {
  if (!pattern) {
    return false;
  }
  if (!hasGlobToken(pattern)) {
    return relativePath === pattern || relativePath.startsWith(`${pattern}/`);
  }

  return filesPatternToRegExp(pattern).test(relativePath);
}

function filesPatternToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
      continue;
    }
    if (pattern.startsWith('**', index)) {
      source += '.*';
      index += 2;
      continue;
    }

    const character = pattern[index];
    if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '[' || character === '{') {
      source += '[^/]*';
    } else {
      source += escapeRegExp(character);
    }
    index += 1;
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
