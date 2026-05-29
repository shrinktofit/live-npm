import path from 'node:path';
import type { LiveNpmPackageConfig, LiveNpmWorkspaceConfig } from './config.js';
import { pnpmWorkspaceDriver } from './pnpm-workspace-driver.js';
import { detectWorkspaceManager, type SupportedWorkspaceManager } from './workspace-detection.js';
import type { WorkspaceDriver, WorkspacePackage } from './workspace-driver.js';
import type { PackageManifest } from './package-plan.js';

const workspaceDrivers: Record<SupportedWorkspaceManager, WorkspaceDriver> = {
  pnpm: pnpmWorkspaceDriver,
};

export async function resolveConfiguredPackages(
  packages: LiveNpmPackageConfig[],
  workspaces: LiveNpmWorkspaceConfig[],
): Promise<LiveNpmPackageConfig[]> {
  const resolvedPackages = [...packages];
  for (const workspaceConfig of workspaces) {
    resolvedPackages.push(...await resolveWorkspacePackageConfigs(workspaceConfig));
  }
  return resolvedPackages;
}

export async function resolveWorkspacePackageConfigs(
  workspaceConfig: LiveNpmWorkspaceConfig,
): Promise<LiveNpmPackageConfig[]> {
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
        workspaceVersions,
      },
      source: workspacePackage.path,
      target: packageTargetPath(workspaceConfig.target, workspacePackage.name),
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

function packageTargetPath(targetRoot: string, packageName: string): string {
  return path.join(targetRoot, ...packageName.split('/'));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string');
}
