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
  const watchPaths = new Set<string>([
    path.join(source, 'package.json'),
  ]);

  if (files) {
    for (const entry of files) {
      if (entry.startsWith('!')) {
        continue;
      }
      watchPaths.add(path.resolve(source, entry));
    }
  } else {
    watchPaths.add(source);
  }

  for (const defaultFile of [
    'README',
    'README.md',
    'LICENSE',
    'LICENSE.md',
    'LICENCE',
    'LICENCE.md',
    'NOTICE',
  ]) {
    watchPaths.add(path.join(source, defaultFile));
  }

  return [...watchPaths];
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
