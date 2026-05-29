import type { CatalogRewriteConfig, ManifestRewriteConfig } from './config.js';
import type { PackageManifest } from './package-plan.js';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export function rewritePublishManifest(manifest: PackageManifest, config: ManifestRewriteConfig): PackageManifest {
  const next = JSON.parse(JSON.stringify(manifest)) as PackageManifest;

  for (const field of dependencyFields) {
    const dependencies = next[field];
    if (!isStringRecord(dependencies)) {
      continue;
    }

    next[field] = Object.fromEntries(
      Object.entries(dependencies).map(([dependencyName, spec]) => [
        dependencyName,
        rewriteDependencySpec(dependencyName, spec, config, field, 0),
      ]),
    );
  }

  return next;
}

function rewriteDependencySpec(
  dependencyName: string,
  spec: string,
  config: ManifestRewriteConfig,
  field: typeof dependencyFields[number],
  depth: number,
): string {
  if (depth > 4) {
    throw new Error(`Could not resolve recursive dependency protocol for ${dependencyName}: ${spec}`);
  }

  if (shouldUseLiveDependency(dependencyName, field, config)) {
    return `live:${dependencyName}`;
  }

  if (spec.startsWith('workspace:')) {
    return rewriteWorkspaceSpec(dependencyName, spec, config.workspaceVersions);
  }

  if (spec.startsWith('catalog:')) {
    const catalogSpec = readCatalogSpec(dependencyName, spec, config.catalogs);
    return rewriteDependencySpec(dependencyName, catalogSpec, config, field, depth + 1);
  }

  return spec;
}

function shouldUseLiveDependency(
  dependencyName: string,
  field: typeof dependencyFields[number],
  config: ManifestRewriteConfig,
): boolean {
  if (field !== 'dependencies' && field !== 'optionalDependencies') {
    return false;
  }
  return config.liveDependencyNames?.includes(dependencyName) ?? false;
}

function rewriteWorkspaceSpec(
  dependencyName: string,
  spec: string,
  workspaceVersions: Record<string, string>,
): string {
  const version = workspaceVersions[dependencyName];
  if (!version) {
    throw new Error(`${dependencyName} uses ${spec}, but it was not found in the workspace.`);
  }

  const range = spec.slice('workspace:'.length);
  if (range === '' || range === '*') {
    return version;
  }
  if (range === '^' || range === '~') {
    return `${range}${version}`;
  }
  if (range.startsWith('./') || range.startsWith('../') || /^[A-Za-z]:[\\/]/.test(range)) {
    return version;
  }
  return range;
}

function readCatalogSpec(dependencyName: string, spec: string, catalogs: CatalogRewriteConfig): string {
  const rawCatalogName = spec.slice('catalog:'.length);
  const catalogName = rawCatalogName === '' || rawCatalogName === '*' ? 'default' : rawCatalogName;
  const catalog = catalogName === 'default' ? catalogs.default : catalogs.named[catalogName];
  if (!catalog) {
    throw new Error(`${dependencyName} uses ${spec}, but catalog ${catalogName} was not found.`);
  }

  const catalogSpec = catalog[dependencyName];
  if (!catalogSpec) {
    throw new Error(`${dependencyName} uses ${spec}, but it was not found in catalog ${catalogName}.`);
  }
  return catalogSpec;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}
