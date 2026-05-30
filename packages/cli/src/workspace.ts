import type { LiveNpmPackageConfig, LiveNpmWorkspaceConfig } from './config.js';
import { pnpmWorkspaceDriver } from './pnpm-workspace-driver.js';
import { detectWorkspaceManager, type SupportedWorkspaceManager } from './workspace-detection.js';
import type { WorkspaceDriver, WorkspacePackage } from './workspace-driver.js';
import { readManifest, type PackageManifest } from './package-plan.js';

const workspaceDrivers: Record<SupportedWorkspaceManager, WorkspaceDriver> = {
  pnpm: pnpmWorkspaceDriver,
};

export interface ResolvedLivePackage {
  extraWatchPaths?: string[];
  manifestRewrite?: LiveNpmPackageConfig['manifestRewrite'];
  name: string;
  source: string;
  watchGroup: ResolvedWatchGroup;
}

export interface ResolvedWatchGroup {
  kind: 'package' | 'workspace';
  key: string;
  root: string;
}

export async function resolveConfiguredPackages(
  packages: LiveNpmPackageConfig[],
  workspaces: LiveNpmWorkspaceConfig[],
): Promise<ResolvedLivePackage[]> {
  const resolvedPackages: ResolvedLivePackage[] = await Promise.all(packages.map(async (packageConfig) => {
    const manifest = await readManifest(packageConfig.source);
    return {
      ...(packageConfig.extraWatchPaths ? { extraWatchPaths: packageConfig.extraWatchPaths } : {}),
      ...(packageConfig.manifestRewrite ? { manifestRewrite: packageConfig.manifestRewrite } : {}),
      name: readPackageName(manifest, packageConfig.source),
      source: packageConfig.source,
      watchGroup: {
        kind: 'package',
        key: `package:${packageConfig.source}`,
        root: packageConfig.source,
      },
    };
  }));
  for (const workspaceConfig of workspaces) {
    resolvedPackages.push(...await resolveWorkspacePackageConfigs(workspaceConfig));
  }
  return resolvedPackages;
}

export async function resolveWorkspacePackageConfigs(
  workspaceConfig: LiveNpmWorkspaceConfig,
): Promise<ResolvedLivePackage[]> {
  const driver = await resolveWorkspaceDriver(workspaceConfig.path);
  const packages = await driver.listPackages(workspaceConfig.path);
  const packageByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const includedNames = new Set<string>();

  for (const include of workspaceConfig.includes) {
    if (!packageByName.has(include)) {
      throw new Error(`Workspace ${workspaceConfig.path} does not contain package ${include}.`);
    }
    includedNames.add(include);
  }

  const selectedNames = expandWorkspaceDependencyClosure([...includedNames], packageByName);
  const catalogs = await driver.readCatalogs(workspaceConfig.path);
  const workspaceVersions = Object.fromEntries(
    packages
      .filter((workspacePackage): workspacePackage is WorkspacePackage & { version: string } => Boolean(workspacePackage.version))
      .map((workspacePackage) => [workspacePackage.name, workspacePackage.version]),
  );
  const extraWatchPaths = await driver.readMetadataPaths(workspaceConfig.path);

  return selectedNames.map((packageName) => {
    const workspacePackage = packageByName.get(packageName);
    if (!workspacePackage) {
      throw new Error(`Workspace package ${packageName} disappeared while resolving ${workspaceConfig.path}.`);
    }

    return {
      extraWatchPaths,
      manifestRewrite: {
        catalogs,
        liveDependencyNames: selectedNames,
        workspaceVersions,
      },
      name: workspacePackage.name,
      source: workspacePackage.path,
      watchGroup: {
        kind: 'workspace',
        key: `workspace:${workspaceConfig.path}`,
        root: workspaceConfig.path,
      },
    };
  });
}

async function resolveWorkspaceDriver(workspacePath: string): Promise<WorkspaceDriver> {
  const manager = await detectWorkspaceManager(workspacePath);
  if (!manager) {
    throw new Error(`Could not infer a supported package manager for ${workspacePath}. Expected packageManager: pnpm, pnpm-workspace.yaml, or pnpm-lock.yaml.`);
  }

  if (!(manager in workspaceDrivers)) {
    throw new Error(`Workspace ${workspacePath} uses ${manager}; live-npm workspace mode currently supports pnpm only.`);
  }

  return workspaceDrivers[manager as SupportedWorkspaceManager];
}

function expandWorkspaceDependencyClosure(
  initialNames: string[],
  packageByName: Map<string, WorkspacePackage>,
): string[] {
  const selectedNames = new Set(initialNames);
  const queue = [...initialNames];

  for (const packageName of queue) {
    const workspacePackage = packageByName.get(packageName);
    if (!workspacePackage) {
      continue;
    }

    for (const dependencyName of readWorkspaceDependencyNames(workspacePackage.manifest, packageByName)) {
      if (selectedNames.has(dependencyName)) {
        continue;
      }
      selectedNames.add(dependencyName);
      queue.push(dependencyName);
    }
  }

  return [...selectedNames];
}

function readWorkspaceDependencyNames(
  manifest: PackageManifest,
  packageByName: Map<string, WorkspacePackage>,
): string[] {
  const dependencyNames = new Set<string>();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const dependencies = manifest[field];
    if (!isStringRecord(dependencies)) {
      continue;
    }

    for (const [dependencyName, spec] of Object.entries(dependencies)) {
      if (spec.startsWith('workspace:') || packageByName.has(dependencyName)) {
        dependencyNames.add(dependencyName);
      }
    }
  }
  return [...dependencyNames];
}

function readPackageName(manifest: PackageManifest, source: string): string {
  if (typeof manifest.name === 'string' && manifest.name.length > 0) {
    return manifest.name;
  }
  return source;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}
