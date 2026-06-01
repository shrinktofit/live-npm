import {
  createServer,
  request as createServerRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import chalk from 'chalk';
import chokidar, { type FSWatcher } from 'chokidar';
import { loadConfig } from './config.js';
import { consoleLogger, type Logger } from './logger.js';
import { currentIntegrationVersion, integrationPnpmfileMode, integrationVersionFileName } from './integration-version.js';
import { rewritePublishManifest } from './manifest-rewrite.js';
import {
  createPublishWatchIgnored,
  getWatchPlan,
  readManifest,
  type ShallowWatchPath,
} from './package-plan.js';
import { publishPackage, publishPackageChanges, type PublishFileChange } from './publisher.js';
import { resolveConfiguredPackages, type ResolvedLivePackage } from './workspace.js';

const liveDirName = '.live-npm';
const storeDirName = 'store';
const stateFileName = 'state.json';
const serverFileName = 'server.json';
const tokenHeaderName = 'x-live-npm-token';

export interface LiveNpmServerOptions {
  host: string;
  logger?: Logger;
  port: number;
  projectDirs?: string[];
}

export interface LiveNpmServer {
  close(): Promise<void>;
  url: string;
}

interface ResolveRequest {
  packageName: string;
  projectDir: string;
}

interface FetchRequest {
  packageName: string;
  projectDir: string;
}

interface RegisterImportRequest {
  destinationDir: string;
  packageName: string;
  projectDir: string;
}

interface RuntimePackage {
  config: ResolvedLivePackage;
  debounceMs: number;
  lastError?: string;
  lastPublishAt?: string;
  projectDir: string;
  targets: Set<string>;
}

interface ProjectRuntime {
  configError?: string;
  configPath: string;
  projectDir: string;
  warnedMissingState: boolean;
  watcher?: FSWatcher;
}

interface WatchGroup {
  debounceMs: number;
  kind: ResolvedLivePackage['watchGroup']['kind'];
  key: string;
  lastError?: string;
  lastEvent?: WatchEventStatus;
  metadataPaths: string[];
  pendingForceRewatch: boolean;
  pendingPublishes: Map<RuntimePackage, PendingPublish>;
  projectDir: string;
  root: string;
  runtimes: Set<RuntimePackage>;
  shallowWatchPaths?: ShallowWatchPath[];
  watcher?: FSWatcher;
  watchPaths?: string[];
}

interface WatchEventStatus {
  at: string;
  event: string;
  packageNames: string[];
  path: string;
  relativePath: string;
}

interface PendingPublish {
  changes: PublishFileChange[];
  full: boolean;
}

type PendingPublishKind
  = | {
    forceRewatch: boolean;
    full: true;
  }
  | {
    change: PublishFileChange;
    forceRewatch: boolean;
    full: false;
  };

interface PackageWatchRule {
  ignored: (watchPath: string) => boolean;
  recursiveWatchPaths: string[];
  shallowWatchPaths: ShallowWatchPath[];
  source: string;
}

interface PersistedServer {
  pid: number;
  projectDir: string;
  startedAt: string;
  token: string;
  url: string;
  version: 1;
}

interface PersistedState {
  imports: PersistedImport[];
  version: 1;
}

interface PersistedIntegrationVersion {
  generatedAt: string;
  integrationVersion: number;
  liveNpmVersion: string;
  pnpmfileMode: string;
  schemaVersion: 1;
}

interface PersistedImport {
  destinationDir: string;
  packageName: string;
}

export async function startLiveNpmServer(options: LiveNpmServerOptions): Promise<LiveNpmServer> {
  const logger = options.logger ?? consoleLogger;
  const projectDirs = [...new Set((options.projectDirs ?? []).map((projectDir) => path.resolve(projectDir)))];
  const previousServerStates = await Promise.all(projectDirs.map(readServerState));
  for (const projectDir of projectDirs) {
    const runningServer = await readRunningServer(projectDir);
    if (runningServer) {
      throw new Error(`live-npm is already running for ${projectDir} at ${runningServer.url}.`);
    }
  }
  const token = randomUUID();
  const manager = new LiveNpmServerManager(logger, token);
  const server = createServer((request, response) => {
    void handleRequest(manager, request, response);
  });

  const preferredPort = options.port === 0 ? readPreferredPort(previousServerStates) : options.port;
  const actualPort = await listenServer(server, options.host, preferredPort);
  if (preferredPort !== options.port && actualPort !== preferredPort) {
    logger.warn(`Previous live-npm port ${preferredPort} is unavailable; using ${actualPort}. pnpm hooks read .live-npm/server.json, so reinstall is not required.`);
  }

  const url = `http://${options.host}:${actualPort}`;
  const serverState: Omit<PersistedServer, 'projectDir'> = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
    url,
    version: 1,
  };
  for (const projectDir of projectDirs) {
    await writeServerState(projectDir, {
      ...serverState,
      projectDir,
    });
  }
  for (const projectDir of projectDirs) {
    await warnIfOutdatedIntegration(projectDir, logger);
  }
  for (const projectDir of projectDirs) {
    await manager.startProject(projectDir);
  }
  logger.info(`${chalk.bold.cyan('live-npm server')} ${chalk.green('listening')} ${chalk.dim('on')} ${chalk.cyan(url)}`);

  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await manager.close();
      await Promise.all(projectDirs.map(async (projectDir) => {
        await removeServerState(projectDir, token);
      }));
    },
    url,
  };
}

class LiveNpmServerManager {
  private readonly logger: Logger;
  private readonly projects = new Map<string, ProjectRuntime>();
  private readonly runtimes = new Map<string, RuntimePackage>();
  private readonly token: string;
  private readonly watchGroups = new Map<string, WatchGroup>();

  constructor(logger: Logger, token: string) {
    this.logger = logger;
    this.token = token;
  }

  authenticate(request: IncomingMessage): boolean {
    return request.headers[tokenHeaderName] === this.token;
  }

  async resolve(request: ResolveRequest): Promise<unknown> {
    const runtime = await this.ensureRuntime(request.projectDir, request.packageName);
    const manifest = await this.readPublishedManifest(runtime.config);
    return {
      manifest,
      packageName: runtime.config.name,
      stagingDir: packageStagingDir(runtime.projectDir, runtime.config.name),
    };
  }

  async fetch(request: FetchRequest): Promise<unknown> {
    const runtime = await this.ensureRuntime(request.projectDir, request.packageName);
    const stagingDir = packageStagingDir(runtime.projectDir, runtime.config.name);
    runtime.targets.add(stagingDir);
    await this.publishRuntime(runtime);
    const manifest = await this.readPublishedManifest(runtime.config);
    return {
      manifest,
      packageName: runtime.config.name,
      stagingDir,
    };
  }

  async registerImport(request: RegisterImportRequest): Promise<unknown> {
    const runtime = await this.ensureRuntime(request.projectDir, request.packageName);
    runtime.targets.add(path.resolve(request.destinationDir));
    await this.publishRuntime(runtime);
    await this.writeState(runtime.projectDir);
    return {
      packageName: runtime.config.name,
      targets: [...runtime.targets],
    };
  }

  async startProject(projectDir: string): Promise<void> {
    const resolvedProjectDir = path.resolve(projectDir);
    const project = this.ensureProject(resolvedProjectDir);
    await this.reconcileProject(project, { keepCurrentOnError: false, warnMissingState: true });
    await this.watchProjectConfig(project);
  }

  async close(): Promise<void> {
    await Promise.all([
      ...[...this.watchGroups.values()].map(async (group) => group.watcher?.close()),
      ...[...this.projects.values()].map(async (project) => project.watcher?.close()),
    ]);
  }

  status(): unknown {
    return {
      pid: process.pid,
      projectErrors: [...this.projects.values()]
        .filter((project) => project.configError)
        .map((project) => ({
          error: project.configError,
          projectDir: project.projectDir,
        })),
      projects: [...this.projects.keys()].sort(),
      watchGroups: [...this.watchGroups.values()].map((group) => {
        const watched = group.watcher?.getWatched() ?? {};
        return {
          key: group.key,
          kind: group.kind,
          lastError: group.lastError,
          lastEvent: group.lastEvent,
          packages: [...group.runtimes].map((runtime) => runtime.config.name).sort(),
          projectDir: group.projectDir,
          root: group.root,
          shallowWatchPaths: group.shallowWatchPaths ?? [],
          watchedDirs: Object.keys(watched).length,
          watchedEntries: Object.values(watched).reduce((sum, entries) => sum + entries.length, 0),
          watchPaths: group.watchPaths ?? [],
        };
      }).sort((left, right) => left.key.localeCompare(right.key)),
      packages: [...this.runtimes.values()].map((runtime) => ({
        lastError: runtime.lastError,
        lastPublishAt: runtime.lastPublishAt,
        name: runtime.config.name,
        projectDir: runtime.projectDir,
        source: runtime.config.source,
        targets: [...runtime.targets].sort(),
        watchGroupKey: runtime.config.watchGroup.key,
      })).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private ensureProject(projectDir: string): ProjectRuntime {
    const resolvedProjectDir = path.resolve(projectDir);
    const existing = this.projects.get(resolvedProjectDir);
    if (existing) {
      return existing;
    }

    const project: ProjectRuntime = {
      configPath: path.join(resolvedProjectDir, liveDirName, 'config.yaml'),
      projectDir: resolvedProjectDir,
      warnedMissingState: false,
    };
    this.projects.set(resolvedProjectDir, project);
    return project;
  }

  private async watchProjectConfig(project: ProjectRuntime): Promise<void> {
    if (project.watcher) {
      return;
    }

    const schedule = debounce(async () => {
      await this.reconcileProject(project, { keepCurrentOnError: true, warnMissingState: false });
    }, 100);
    const watcher = chokidar.watch(project.configPath, {
      awaitWriteFinish: {
        pollInterval: 50,
        stabilityThreshold: 150,
      },
      ignoreInitial: true,
    });
    watcher.on('all', (event) => {
      this.logger.debug(`project config ${event} ${project.configPath}`);
      schedule();
    });
    watcher.on('error', (error) => {
      project.configError = formatErrorMessage(error);
      this.logger.error(formatUnknownError(error));
    });
    project.watcher = watcher;
  }

  private async reconcileProject(
    projectRuntime: ProjectRuntime,
    options: {
      keepCurrentOnError: boolean;
      warnMissingState: boolean;
    },
  ): Promise<void> {
    try {
      await this.applyProjectConfig(projectRuntime, options);
      delete projectRuntime.configError;
    } catch (error) {
      projectRuntime.configError = formatErrorMessage(error);
      if (!options.keepCurrentOnError) {
        throw error;
      }
      this.logger.error(`could not reload ${projectRuntime.configPath}: ${formatUnknownError(error)}`);
    }
  }

  private async applyProjectConfig(
    projectRuntime: ProjectRuntime,
    options: {
      warnMissingState: boolean;
    },
  ): Promise<void> {
    const stateExists = await exists(path.join(projectRuntime.projectDir, liveDirName, stateFileName));
    if (!await exists(projectRuntime.configPath)) {
      if (this.hasProjectRuntimes(projectRuntime.projectDir)) {
        throw new Error(`Config ${projectRuntime.configPath} does not exist.`);
      }
      if (stateExists && options.warnMissingState) {
        this.logger.warn(`No ${projectRuntime.configPath} found. live-npm cannot restore persisted live package targets until config.yaml is created.`);
      }
      return;
    }

    const project = await loadProject(projectRuntime.projectDir);
    if (!stateExists && options.warnMissingState && !projectRuntime.warnedMissingState) {
      projectRuntime.warnedMissingState = true;
      this.logger.warn(`No ${path.join(projectRuntime.projectDir, liveDirName, stateFileName)} found. Run pnpm install once while live-npm is running so pnpm can register live package import targets.`);
    }

    const state = stateExists
      ? await readState(projectRuntime.projectDir)
      : { imports: [], version: 1 } satisfies PersistedState;
    const importTargets = groupImportsByPackage(state.imports);
    const desiredConfigByName = new Map(project.packages.map((packageConfig) => [packageConfig.name, packageConfig]));
    const existingRuntimes = [...this.runtimes.values()]
      .filter((runtime) => runtime.projectDir === projectRuntime.projectDir);
    const existingRuntimeByName = new Map(existingRuntimes.map((runtime) => [runtime.config.name, runtime]));

    for (const runtime of existingRuntimes) {
      if (!desiredConfigByName.has(runtime.config.name)) {
        await this.removeRuntime(runtime, { deleteTargets: true });
      }
    }
    for (const [packageName, targets] of importTargets) {
      if (!desiredConfigByName.has(packageName) && !existingRuntimeByName.has(packageName)) {
        await this.deletePackageTargets(projectRuntime.projectDir, packageName, [
          packageStagingDir(projectRuntime.projectDir, packageName),
          ...targets,
        ]);
      }
    }

    const activeNames = new Set([
      ...existingRuntimeByName.keys(),
      ...importTargets.keys(),
    ]);
    for (const packageName of [...activeNames].sort((left, right) => left.localeCompare(right))) {
      const config = desiredConfigByName.get(packageName);
      if (!config) {
        continue;
      }

      const existing = this.runtimes.get(runtimeKey(projectRuntime.projectDir, packageName));
      const targets = new Set([
        packageStagingDir(projectRuntime.projectDir, packageName),
        ...(importTargets.get(packageName) ?? []),
        ...(existing ? [...existing.targets] : []),
      ]);

      if (existing) {
        await this.updateRuntimeConfig(existing, config, project.debounceMs, targets);
        continue;
      }

      const runtime: RuntimePackage = {
        config,
        debounceMs: project.debounceMs,
        projectDir: projectRuntime.projectDir,
        targets,
      };
      this.runtimes.set(runtimeKey(projectRuntime.projectDir, config.name), runtime);
      await this.startRuntime(runtime);
      for (const target of importTargets.get(packageName) ?? []) {
        this.logger.info(`${chalk.green('restored')} ${formatPackageTarget(packageName, target)}`);
      }
    }

    if (stateExists || [...this.runtimes.values()].some((runtime) => runtime.projectDir === projectRuntime.projectDir)) {
      await this.writeState(projectRuntime.projectDir);
    }
  }

  private hasProjectRuntimes(projectDir: string): boolean {
    return [...this.runtimes.values()].some((runtime) => runtime.projectDir === projectDir);
  }

  private async updateRuntimeConfig(
    runtime: RuntimePackage,
    config: ResolvedLivePackage,
    debounceMs: number,
    targets: Set<string>,
  ): Promise<void> {
    const oldWatchGroupKey = runtime.config.watchGroup.key;
    const configChanged = serializeResolvedLivePackage(runtime.config) !== serializeResolvedLivePackage(config);
    const debounceChanged = runtime.debounceMs !== debounceMs;
    runtime.config = config;
    runtime.debounceMs = debounceMs;
    runtime.targets = targets;

    if (!configChanged && !debounceChanged) {
      return;
    }

    if (oldWatchGroupKey !== config.watchGroup.key) {
      await this.unregisterRuntimeWatcher(runtime, oldWatchGroupKey);
      await this.registerRuntimeWatcher(runtime);
    } else {
      const group = this.watchGroups.get(watchGroupRuntimeKey(runtime.projectDir, config.watchGroup.key));
      if (group) {
        group.debounceMs = debounceMs;
        await this.replaceWatchGroup(group, true);
      }
    }

    await this.publishRuntime(runtime);
  }

  private async ensureRuntime(projectDir: string, packageName: string): Promise<RuntimePackage> {
    const resolvedProjectDir = path.resolve(projectDir);
    this.ensureProject(resolvedProjectDir);
    const key = runtimeKey(resolvedProjectDir, packageName);
    const existing = this.runtimes.get(key);
    if (existing) {
      return existing;
    }

    const project = await loadProject(resolvedProjectDir);
    const config = project.packages.find((packageConfig) => packageConfig.name === packageName);
    if (!config) {
      throw new Error(createMissingPackageError(resolvedProjectDir, packageName, project.packages));
    }

    const runtime: RuntimePackage = {
      config,
      debounceMs: project.debounceMs,
      projectDir: resolvedProjectDir,
      targets: new Set([packageStagingDir(resolvedProjectDir, config.name)]),
    };
    this.runtimes.set(key, runtime);
    await this.startRuntime(runtime);
    return runtime;
  }

  private async startRuntime(runtime: RuntimePackage): Promise<void> {
    await this.publishRuntime(runtime);
    await this.registerRuntimeWatcher(runtime);
  }

  private async registerRuntimeWatcher(runtime: RuntimePackage): Promise<void> {
    const groupKey = watchGroupRuntimeKey(runtime.projectDir, runtime.config.watchGroup.key);
    let group = this.watchGroups.get(groupKey);
    if (!group) {
      group = {
        debounceMs: runtime.debounceMs,
        key: runtime.config.watchGroup.key,
        kind: runtime.config.watchGroup.kind,
        metadataPaths: [],
        pendingForceRewatch: false,
        pendingPublishes: new Map(),
        projectDir: runtime.projectDir,
        root: runtime.config.watchGroup.root,
        runtimes: new Set(),
      };
      this.watchGroups.set(groupKey, group);
    }

    group.runtimes.add(runtime);
    await this.replaceWatchGroup(group);
  }

  private async unregisterRuntimeWatcher(runtime: RuntimePackage, watchGroupKey: string): Promise<void> {
    const groupKey = watchGroupRuntimeKey(runtime.projectDir, watchGroupKey);
    const group = this.watchGroups.get(groupKey);
    if (!group) {
      return;
    }

    group.runtimes.delete(runtime);
    group.pendingPublishes.delete(runtime);
    if (group.runtimes.size === 0) {
      await group.watcher?.close();
      this.watchGroups.delete(groupKey);
      return;
    }

    await this.replaceWatchGroup(group, true);
  }

  private async removeRuntime(runtime: RuntimePackage, options: { deleteTargets: boolean }): Promise<void> {
    this.runtimes.delete(runtimeKey(runtime.projectDir, runtime.config.name));
    await this.unregisterRuntimeWatcher(runtime, runtime.config.watchGroup.key);

    if (!options.deleteTargets) {
      return;
    }

    await this.deletePackageTargets(runtime.projectDir, runtime.config.name, [...runtime.targets]);
  }

  private async deletePackageTargets(projectDir: string, packageName: string, targets: string[]): Promise<void> {
    await Promise.all([...new Set(targets)].map(async (target) => {
      if (!isSafeLiveTarget(projectDir, target)) {
        this.logger.warn(`Refusing to delete live-npm target outside a managed location: ${target}`);
        return;
      }
      await rm(target, { force: true, recursive: true });
      this.logger.info(`${chalk.yellow('deleted')} ${formatPackageTarget(packageName, target)}`);
    }));
  }

  private async replaceWatchGroup(group: WatchGroup, force = false): Promise<void> {
    const plan = await this.createWatchGroupPlan(group);
    if (
      !force
      && group.watcher
      && group.watchPaths
      && group.shallowWatchPaths
      && areSameWatchPaths(group.watchPaths, plan.watchPaths)
      && areSameShallowWatchPaths(group.shallowWatchPaths, plan.shallowWatchPaths)
    ) {
      return;
    }

    await group.watcher?.close();
    delete group.watcher;
    group.watchPaths = plan.watchPaths;
    group.shallowWatchPaths = plan.shallowWatchPaths;
    group.metadataPaths = plan.metadataPaths;

    const schedule = debounce(async () => {
      try {
        const pendingPublishes = [...group.pendingPublishes];
        group.pendingPublishes.clear();
        const pendingForceRewatch = group.pendingForceRewatch;
        group.pendingForceRewatch = false;
        await Promise.all(pendingPublishes.map(async ([runtime, pending]) => {
          if (pending.full) {
            await this.publishRuntime(runtime);
            return;
          }
          await this.publishRuntimeChanges(runtime, pending.changes);
        }));
        if (pendingForceRewatch) {
          await this.replaceWatchGroup(group, true);
        }
      } catch (error) {
        group.lastError = formatErrorMessage(error);
        this.logger.error(formatUnknownError(error));
      }
    }, group.debounceMs);

    const watcher = chokidar.watch(plan.watchPaths, {
      awaitWriteFinish: {
        pollInterval: 50,
        stabilityThreshold: 150,
      },
      ignoreInitial: true,
      ignored: plan.ignored,
    });

    watcher.on('all', (event, changedPath) => {
      const affectedRuntimes = this.getAffectedRuntimes(group, changedPath);
      group.lastEvent = {
        at: new Date().toISOString(),
        event,
        packageNames: affectedRuntimes.map((runtime) => runtime.config.name).sort(),
        path: path.resolve(changedPath),
        relativePath: path.relative(group.root, changedPath),
      };
      this.logger.debug(`${event} ${path.relative(group.root, changedPath)}`);
      for (const runtime of affectedRuntimes) {
        const publishKind = this.getPublishKind(group, runtime, event, changedPath, plan.shallowWatchPaths);
        queuePendingPublish(group, runtime, publishKind);
        if (publishKind.forceRewatch) {
          group.pendingForceRewatch = true;
        }
      }
      schedule();
    });
    watcher.on('error', (error) => {
      group.lastError = formatErrorMessage(error);
      this.logger.error(formatUnknownError(error));
    });

    group.watcher = watcher;
    delete group.lastError;
    this.logger.info(`${chalk.cyan('watching')} ${chalk.magenta(group.kind)} ${chalk.dim(group.root)} ${chalk.dim('for')} ${chalk.cyan(group.runtimes.size)} ${chalk.dim(plural(group.runtimes.size, 'package'))}`);
  }

  private async createWatchGroupPlan(group: WatchGroup): Promise<{
    ignored: (watchPath: string) => boolean;
    metadataPaths: string[];
    shallowWatchPaths: ShallowWatchPath[];
    watchPaths: string[];
  }> {
    const watchPaths: string[] = [];
    const packageRules: PackageWatchRule[] = [];
    const metadataPaths: string[] = [];
    const shallowWatchPaths: ShallowWatchPath[] = [];

    for (const runtime of group.runtimes) {
      const manifest = await readManifest(runtime.config.source);
      const watchPlan = getWatchPlan(runtime.config.source, manifest);
      packageRules.push({
        ignored: createPublishWatchIgnored(runtime.config.source, manifest),
        recursiveWatchPaths: watchPlan.recursiveWatchPaths,
        shallowWatchPaths: watchPlan.shallowWatchPaths,
        source: path.resolve(runtime.config.source),
      });
      for (const watchPath of watchPlan.watchPaths) {
        addUniqueWatchPath(watchPaths, watchPath);
      }
      for (const shallowWatchPath of watchPlan.shallowWatchPaths) {
        addUniqueShallowWatchPath(shallowWatchPaths, shallowWatchPath);
      }
      for (const watchPath of runtime.config.extraWatchPaths ?? []) {
        addUniqueWatchPath(watchPaths, watchPath);
        metadataPaths.push(path.resolve(watchPath));
      }
    }

    return {
      ignored(watchPath) {
        const resolvedWatchPath = path.resolve(watchPath);
        if (metadataPaths.some((metadataPath) => isInsideOrSame(metadataPath, resolvedWatchPath))) {
          return false;
        }

        const matchingPackageRules = packageRules.filter((rule) => isInsideOrSame(rule.source, resolvedWatchPath));
        if (matchingPackageRules.length === 0) {
          return true;
        }

        return matchingPackageRules.every((rule) => shouldIgnorePackageWatchPath(rule, resolvedWatchPath));
      },
      metadataPaths: [...new Set(metadataPaths)].sort(),
      shallowWatchPaths: shallowWatchPaths.sort(compareShallowWatchPaths),
      watchPaths: watchPaths.sort((left, right) => left.localeCompare(right)),
    };
  }

  private getAffectedRuntimes(group: WatchGroup, changedPath: string): RuntimePackage[] {
    const resolvedChangedPath = path.resolve(changedPath);
    if (group.metadataPaths.some((metadataPath) => isInsideOrSame(metadataPath, resolvedChangedPath))) {
      return [...group.runtimes];
    }

    const affected = [...group.runtimes].filter((runtime) => isInsideOrSame(runtime.config.source, resolvedChangedPath));
    if (affected.length > 0) {
      return affected;
    }
    return [...group.runtimes];
  }

  private getPublishKind(
    group: WatchGroup,
    runtime: RuntimePackage,
    event: string,
    changedPath: string,
    shallowWatchPaths: ShallowWatchPath[],
  ): PendingPublishKind {
    if (isGroupMetadataPath(group, changedPath)) {
      return {
        forceRewatch: false,
        full: true,
      };
    }
    if (isRuntimePublishMetadata(runtime, changedPath)) {
      return {
        forceRewatch: true,
        full: true,
      };
    }
    if (isShallowTargetHit(shallowWatchPaths, changedPath)) {
      return {
        change: {
          event,
          path: changedPath,
        },
        forceRewatch: true,
        full: false,
      };
    }
    return {
      change: {
        event,
        path: changedPath,
      },
      forceRewatch: false,
      full: false,
    };
  }

  private async publishRuntime(runtime: RuntimePackage): Promise<void> {
    try {
      await Promise.all([...runtime.targets].map(async (target) => {
        await publishPackage(runtime.config.source, target, {
          dryRun: false,
          logger: this.logger,
          ...(runtime.config.manifestRewrite ? { manifestRewrite: runtime.config.manifestRewrite } : {}),
        });
      }));
      runtime.lastPublishAt = new Date().toISOString();
      delete runtime.lastError;
    } catch (error) {
      runtime.lastError = formatErrorMessage(error);
      throw error;
    }
  }

  private async publishRuntimeChanges(runtime: RuntimePackage, changes: PublishFileChange[]): Promise<void> {
    const dedupedChanges = dedupePublishChanges(changes);
    if (dedupedChanges.length === 0) {
      return;
    }

    try {
      await Promise.all([...runtime.targets].map(async (target) => {
        await publishPackageChanges(runtime.config.source, target, dedupedChanges, {
          dryRun: false,
          logger: this.logger,
          ...(runtime.config.manifestRewrite ? { manifestRewrite: runtime.config.manifestRewrite } : {}),
        });
      }));
      runtime.lastPublishAt = new Date().toISOString();
      delete runtime.lastError;
    } catch (error) {
      runtime.lastError = formatErrorMessage(error);
      throw error;
    }
  }

  private async writeState(projectDir: string): Promise<void> {
    const imports: PersistedImport[] = [];
    for (const runtime of this.runtimes.values()) {
      if (runtime.projectDir !== projectDir) {
        continue;
      }
      for (const target of runtime.targets) {
        if (target === packageStagingDir(runtime.projectDir, runtime.config.name)) {
          continue;
        }
        imports.push({
          destinationDir: target,
          packageName: runtime.config.name,
        });
      }
    }
    await writeState(projectDir, {
      imports: sortImports(imports),
      version: 1,
    });
  }

  private async readPublishedManifest(config: ResolvedLivePackage): Promise<unknown> {
    const manifest = await readManifest(config.source);
    if (!config.manifestRewrite) {
      return manifest;
    }
    return rewritePublishManifest(manifest, config.manifestRewrite);
  }
}

async function readState(projectDir: string): Promise<PersistedState> {
  const statePath = path.join(projectDir, liveDirName, stateFileName);
  const data = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.imports)) {
    throw new Error(`${statePath} must contain live-npm state version 1.`);
  }

  return {
    imports: data.imports.map(readPersistedImport),
    version: 1,
  };
}

async function writeState(projectDir: string, state: PersistedState): Promise<void> {
  const liveDir = path.join(projectDir, liveDirName);
  await mkdir(liveDir, { recursive: true });
  await writeFile(path.join(liveDir, stateFileName), `${JSON.stringify(state, null, 2)}\n`);
}

async function warnIfOutdatedIntegration(projectDir: string, logger: Logger): Promise<void> {
  const liveDir = path.join(projectDir, liveDirName);
  if (!await exists(path.join(liveDir, 'config.yaml'))) {
    return;
  }

  const versionPath = path.join(liveDir, integrationVersionFileName);
  const version = await readIntegrationVersion(projectDir);
  if (!version) {
    logger.warn(`No valid ${versionPath} found. Run live-npm integrate to refresh this project's .live-npm files.`);
    return;
  }

  if (version.integrationVersion < currentIntegrationVersion || version.pnpmfileMode !== integrationPnpmfileMode) {
    logger.warn(`${versionPath} was generated by live-npm ${version.liveNpmVersion} with integration version ${version.integrationVersion}. Current integration version is ${currentIntegrationVersion}; run live-npm integrate to refresh this project.`);
    return;
  }

  if (version.integrationVersion > currentIntegrationVersion) {
    logger.warn(`${versionPath} was generated by a newer live-npm integration version ${version.integrationVersion}. Current integration version is ${currentIntegrationVersion}; consider upgrading live-npm.`);
  }
}

async function readIntegrationVersion(projectDir: string): Promise<PersistedIntegrationVersion | undefined> {
  const versionPath = path.join(projectDir, liveDirName, integrationVersionFileName);
  if (!await exists(versionPath)) {
    return undefined;
  }

  try {
    const data = JSON.parse(await readFile(versionPath, 'utf8')) as unknown;
    if (!isRecord(data) || data.schemaVersion !== 1) {
      return undefined;
    }

    return {
      generatedAt: readString(data.generatedAt, 'generatedAt'),
      integrationVersion: readNumber(data.integrationVersion, 'integrationVersion'),
      liveNpmVersion: readString(data.liveNpmVersion, 'liveNpmVersion'),
      pnpmfileMode: readString(data.pnpmfileMode, 'pnpmfileMode'),
      schemaVersion: 1,
    };
  } catch {
    return undefined;
  }
}

async function readServerState(projectDir: string): Promise<PersistedServer | undefined> {
  const serverPath = path.join(projectDir, liveDirName, serverFileName);
  if (!await exists(serverPath)) {
    return undefined;
  }
  const data = JSON.parse(await readFile(serverPath, 'utf8')) as unknown;
  if (!isRecord(data) || data.version !== 1) {
    return undefined;
  }
  return {
    pid: readNumber(data.pid, 'pid'),
    projectDir: readString(data.projectDir, 'projectDir'),
    startedAt: readString(data.startedAt, 'startedAt'),
    token: readString(data.token, 'token'),
    url: readString(data.url, 'url'),
    version: 1,
  };
}

async function writeServerState(projectDir: string, serverState: PersistedServer): Promise<void> {
  const liveDir = path.join(projectDir, liveDirName);
  await mkdir(liveDir, { recursive: true });
  await writeFile(path.join(liveDir, serverFileName), `${JSON.stringify(serverState, null, 2)}\n`);
}

async function removeServerState(projectDir: string, token: string): Promise<void> {
  const serverState = await readServerState(projectDir);
  if (!serverState || serverState.token !== token) {
    return;
  }
  await rm(path.join(projectDir, liveDirName, serverFileName), { force: true });
}

async function readRunningServer(projectDir: string): Promise<PersistedServer | undefined> {
  const serverState = await readServerState(projectDir);
  if (!serverState) {
    return undefined;
  }
  return await pingServer(serverState) ? serverState : undefined;
}

async function pingServer(serverState: PersistedServer): Promise<boolean> {
  const url = new URL('/health', serverState.url);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const request = createServerRequest({
      headers: {
        [tokenHeaderName]: serverState.token,
      },
      host: url.hostname,
      method: 'GET',
      path: url.pathname,
      port: url.port,
    }, (response) => {
      response.resume();
      response.on('end', () => {
        finish(response.statusCode === 200);
      });
    });
    request.setTimeout(500, () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => {
      finish(false);
    });
    request.end();
  });
}

async function listenServer(
  server: ReturnType<typeof createServer>,
  host: string,
  preferredPort: number,
): Promise<number> {
  try {
    return await listenOnPort(server, host, preferredPort);
  } catch (error) {
    if (preferredPort === 0 || !isAddressInUseError(error)) {
      throw error;
    }
    return await listenOnPort(server, host, 0);
  }
}

async function listenOnPort(
  server: ReturnType<typeof createServer>,
  host: string,
  port: number,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function readPreferredPort(previousServerStates: (PersistedServer | undefined)[]): number {
  for (const serverState of previousServerStates) {
    if (!serverState) {
      continue;
    }
    const url = new URL(serverState.url);
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0) {
      return port;
    }
  }
  return 0;
}

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function readPersistedImport(value: unknown): PersistedImport {
  if (!isRecord(value)) {
    throw new Error('Persisted import must be an object.');
  }
  return {
    destinationDir: readString(value.destinationDir, 'destinationDir'),
    packageName: readString(value.packageName, 'packageName'),
  };
}

function sortImports(imports: PersistedImport[]): PersistedImport[] {
  return [...imports].sort((a, b) => {
    const packageOrder = a.packageName.localeCompare(b.packageName);
    if (packageOrder !== 0) {
      return packageOrder;
    }
    return a.destinationDir.localeCompare(b.destinationDir);
  });
}

function groupImportsByPackage(imports: PersistedImport[]): Map<string, string[]> {
  const targetsByPackage = new Map<string, string[]>();
  for (const persistedImport of imports) {
    const targets = targetsByPackage.get(persistedImport.packageName) ?? [];
    targets.push(path.resolve(persistedImport.destinationDir));
    targetsByPackage.set(persistedImport.packageName, targets);
  }
  return targetsByPackage;
}

async function loadProject(projectDir: string): Promise<{ debounceMs: number; packages: ResolvedLivePackage[] }> {
  const config = await loadConfig(path.join(projectDir, liveDirName, 'config.yaml'));
  return {
    debounceMs: config.debounceMs,
    packages: await resolveConfiguredPackages(config.packages, config.workspaces),
  };
}

function createMissingPackageError(
  projectDir: string,
  packageName: string,
  packages: ResolvedLivePackage[],
): string {
  const configPath = path.join(projectDir, liveDirName, 'config.yaml');
  if (packages.length === 0) {
    return `live-npm cannot resolve live:${packageName} because ${configPath} has no source packages or workspaces configured. Add a packages entry or a workspaces entry that includes ${packageName}, then run pnpm install again.`;
  }

  return `live-npm cannot resolve live:${packageName} because ${configPath} does not include ${packageName}. Add it to packages or workspaces.includes, then run pnpm install again.`;
}

async function handleRequest(
  manager: LiveNpmServerManager,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.url === '/health') {
      if (!manager.authenticate(request)) {
        sendJson(response, 401, { error: 'Unauthorized.' });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.url === '/status') {
      if (!manager.authenticate(request)) {
        sendJson(response, 401, { error: 'Unauthorized.' });
        return;
      }
      sendJson(response, 200, manager.status());
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }
    if (!manager.authenticate(request)) {
      sendJson(response, 401, { error: 'Unauthorized.' });
      return;
    }

    const body = await readJsonBody(request);
    if (request.url === '/resolve') {
      sendJson(response, 200, await manager.resolve(readResolveRequest(body)));
      return;
    }
    if (request.url === '/fetch') {
      sendJson(response, 200, await manager.fetch(readFetchRequest(body)));
      return;
    }
    if (request.url === '/register-import') {
      sendJson(response, 200, await manager.registerImport(readRegisterImportRequest(body)));
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    sendJson(response, 500, { error: formatErrorMessage(error) });
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function readResolveRequest(value: unknown): ResolveRequest {
  const data = readRecord(value);
  return {
    packageName: readString(data.packageName, 'packageName'),
    projectDir: readString(data.projectDir, 'projectDir'),
  };
}

function readFetchRequest(value: unknown): FetchRequest {
  const data = readRecord(value);
  return {
    packageName: readString(data.packageName, 'packageName'),
    projectDir: readString(data.projectDir, 'projectDir'),
  };
}

function readRegisterImportRequest(value: unknown): RegisterImportRequest {
  const data = readRecord(value);
  return {
    destinationDir: readString(data.destinationDir, 'destinationDir'),
    packageName: readString(data.packageName, 'packageName'),
    projectDir: readString(data.projectDir, 'projectDir'),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function readNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number.`);
  }
  return value;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(body)}\n`);
}

function packageStagingDir(projectDir: string, packageName: string): string {
  return path.join(projectDir, liveDirName, storeDirName, encodeURIComponent(packageName));
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function runtimeKey(projectDir: string, packageName: string): string {
  return `${path.resolve(projectDir)}\0${packageName}`;
}

function watchGroupRuntimeKey(projectDir: string, watchGroupKey: string): string {
  return `${path.resolve(projectDir)}\0${watchGroupKey}`;
}

function areSameWatchPaths(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((watchPath, index) => watchPath === right[index]);
}

function areSameShallowWatchPaths(left: ShallowWatchPath[], right: ShallowWatchPath[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((watchPath, index) => {
    const rightWatchPath = right[index];
    return rightWatchPath !== undefined
      && watchPath.root === rightWatchPath.root
      && watchPath.target === rightWatchPath.target;
  });
}

function addUniqueWatchPath(paths: string[], watchPath: string): void {
  const resolvedWatchPath = path.resolve(watchPath);
  if (!paths.includes(resolvedWatchPath)) {
    paths.push(resolvedWatchPath);
  }
}

function addUniqueShallowWatchPath(paths: ShallowWatchPath[], watchPath: ShallowWatchPath): void {
  const resolvedWatchPath = {
    root: path.resolve(watchPath.root),
    target: path.resolve(watchPath.target),
  };
  if (paths.some((existing) => existing.root === resolvedWatchPath.root && existing.target === resolvedWatchPath.target)) {
    return;
  }
  paths.push(resolvedWatchPath);
}

function compareShallowWatchPaths(left: ShallowWatchPath, right: ShallowWatchPath): number {
  const rootOrder = left.root.localeCompare(right.root);
  if (rootOrder !== 0) {
    return rootOrder;
  }
  return left.target.localeCompare(right.target);
}

function shouldIgnorePackageWatchPath(rule: PackageWatchRule, resolvedWatchPath: string): boolean {
  if (rule.recursiveWatchPaths.some((watchPath) => isInsideOrSame(watchPath, resolvedWatchPath))) {
    return rule.ignored(resolvedWatchPath);
  }
  if (matchesShallowWatchPath(rule.shallowWatchPaths, resolvedWatchPath)) {
    return rule.ignored(resolvedWatchPath);
  }
  return true;
}

function queuePendingPublish(group: WatchGroup, runtime: RuntimePackage, publishKind: PendingPublishKind): void {
  const pending = group.pendingPublishes.get(runtime) ?? {
    changes: [],
    full: false,
  };

  if (publishKind.full) {
    pending.full = true;
    pending.changes = [];
  } else if (!pending.full) {
    pending.changes.push(publishKind.change);
  }

  group.pendingPublishes.set(runtime, pending);
}

function dedupePublishChanges(changes: PublishFileChange[]): PublishFileChange[] {
  const changeByPath = new Map<string, PublishFileChange>();
  for (const change of changes) {
    changeByPath.set(path.resolve(change.path), {
      event: change.event,
      path: path.resolve(change.path),
    });
  }
  return [...changeByPath.values()];
}

function serializeResolvedLivePackage(config: ResolvedLivePackage): string {
  return JSON.stringify({
    extraWatchPaths: config.extraWatchPaths ?? [],
    manifestRewrite: config.manifestRewrite ?? null,
    name: config.name,
    source: path.resolve(config.source),
    watchGroup: {
      kind: config.watchGroup.kind,
      key: config.watchGroup.key,
      root: path.resolve(config.watchGroup.root),
    },
  });
}

function isSafeLiveTarget(projectDir: string, target: string): boolean {
  const resolvedTarget = path.resolve(target);
  const parsedTarget = path.parse(resolvedTarget);
  if (resolvedTarget === parsedTarget.root || resolvedTarget === path.resolve(projectDir)) {
    return false;
  }
  if (isInsideOrSame(path.join(projectDir, liveDirName, storeDirName), resolvedTarget)) {
    return true;
  }
  return hasPathSegment(resolvedTarget, 'node_modules');
}

function hasPathSegment(file: string, segment: string): boolean {
  return path.resolve(file).split(path.sep).some((part) => part === segment);
}

function matchesShallowWatchPath(shallowWatchPaths: ShallowWatchPath[], changedPath: string): boolean {
  const resolvedChangedPath = path.resolve(changedPath);
  return shallowWatchPaths.some((watchPath) => {
    const root = path.resolve(watchPath.root);
    const target = path.resolve(watchPath.target);
    return isInsideOrSame(root, resolvedChangedPath)
      && (isInsideOrSame(target, resolvedChangedPath) || isInsideOrSame(resolvedChangedPath, target));
  });
}

function isGroupMetadataPath(group: WatchGroup, changedPath: string): boolean {
  const resolvedChangedPath = path.resolve(changedPath);
  return group.metadataPaths.some((metadataPath) => isInsideOrSame(metadataPath, resolvedChangedPath));
}

function isShallowTargetHit(shallowWatchPaths: ShallowWatchPath[], changedPath: string): boolean {
  const resolvedChangedPath = path.resolve(changedPath);
  return shallowWatchPaths.some((watchPath) => {
    const root = path.resolve(watchPath.root);
    const target = path.resolve(watchPath.target);
    return resolvedChangedPath !== root
      && isInsideOrSame(root, resolvedChangedPath)
      && (isInsideOrSame(target, resolvedChangedPath) || isInsideOrSame(resolvedChangedPath, target));
  });
}

function isInsideOrSame(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRuntimePublishMetadata(runtime: RuntimePackage, changedPath: string): boolean {
  const resolvedChangedPath = path.resolve(changedPath);
  if (resolvedChangedPath === path.join(path.resolve(runtime.config.source), 'package.json')) {
    return true;
  }
  const basename = path.basename(resolvedChangedPath);
  return (basename === '.npmignore' || basename === '.gitignore')
    && isInsideOrSame(runtime.config.source, resolvedChangedPath);
}

function formatPackageTarget(packageName: string, target: string): string {
  return `${chalk.bold(packageName)} ${chalk.dim('->')} ${chalk.dim(target)}`;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function debounce(callback: () => Promise<void>, delay: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void callback();
    }, delay);
  };
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
