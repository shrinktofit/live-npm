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
import chokidar, { type FSWatcher } from 'chokidar';
import { loadConfig } from './config.js';
import { consoleLogger, type Logger } from './logger.js';
import { rewritePublishManifest } from './manifest-rewrite.js';
import { readManifest, getWatchPaths } from './package-plan.js';
import { publishPackage } from './publisher.js';
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
  projectDir: string;
  targets: Set<string>;
  watcher?: FSWatcher;
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
    await manager.restoreProject(projectDir);
  }
  logger.info(`live-npm server listening on ${url}`);

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
  private readonly runtimes = new Map<string, RuntimePackage>();
  private readonly token: string;

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

  async restoreProject(projectDir: string): Promise<void> {
    const resolvedProjectDir = path.resolve(projectDir);
    if (!await exists(path.join(resolvedProjectDir, liveDirName, stateFileName))) {
      if (await exists(path.join(resolvedProjectDir, liveDirName, 'config.yaml'))) {
        this.logger.warn(`No ${path.join(resolvedProjectDir, liveDirName, stateFileName)} found. Run pnpm install once while live-npm is running so pnpm can register live package import targets.`);
      }
      return;
    }

    const state = await readState(resolvedProjectDir);
    for (const persistedImport of state.imports) {
      try {
        const runtime = await this.ensureRuntime(resolvedProjectDir, persistedImport.packageName);
        runtime.targets.add(path.resolve(persistedImport.destinationDir));
        await this.publishRuntime(runtime);
        this.logger.info(`restored ${persistedImport.packageName} -> ${persistedImport.destinationDir}`);
      } catch (error) {
        this.logger.warn(`could not restore ${persistedImport.packageName}: ${formatUnknownError(error)}`);
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async (runtime) => runtime.watcher?.close()));
  }

  private async ensureRuntime(projectDir: string, packageName: string): Promise<RuntimePackage> {
    const resolvedProjectDir = path.resolve(projectDir);
    const key = runtimeKey(resolvedProjectDir, packageName);
    const existing = this.runtimes.get(key);
    if (existing) {
      return existing;
    }

    const project = await loadProject(resolvedProjectDir);
    const config = project.packages.find((packageConfig) => packageConfig.name === packageName);
    if (!config) {
      throw new Error(`live-npm config for ${resolvedProjectDir} does not include ${packageName}.`);
    }

    const runtime: RuntimePackage = {
      config,
      debounceMs: project.debounceMs,
      projectDir: resolvedProjectDir,
      targets: new Set([packageStagingDir(resolvedProjectDir, config.name)]),
    };
    this.runtimes.set(key, runtime);
    await this.startWatcher(runtime);
    return runtime;
  }

  private async startWatcher(runtime: RuntimePackage): Promise<void> {
    await this.publishRuntime(runtime);
    const manifest = await readManifest(runtime.config.source);
    const watchPaths = [
      ...getWatchPaths(runtime.config.source, manifest),
      ...(runtime.config.extraWatchPaths ?? []),
    ];
    const schedule = debounce(async () => {
      try {
        await this.publishRuntime(runtime);
      } catch (error) {
        this.logger.error(formatUnknownError(error));
      }
    }, runtime.debounceMs);

    const watcher = chokidar.watch(watchPaths, {
      awaitWriteFinish: {
        pollInterval: 50,
        stabilityThreshold: 150,
      },
      ignoreInitial: true,
      ignored: [
        '**/.git/**',
        '**/.turbo/**',
        '**/node_modules/**',
      ],
    });

    watcher.on('all', (event, changedPath) => {
      this.logger.debug(`${event} ${path.relative(runtime.config.source, changedPath)}`);
      schedule();
    });
    watcher.on('error', (error) => {
      this.logger.error(formatUnknownError(error));
    });

    runtime.watcher = watcher;
    this.logger.info(`watching ${runtime.config.name} from ${runtime.config.source}`);
  }

  private async publishRuntime(runtime: RuntimePackage): Promise<void> {
    await Promise.all([...runtime.targets].map(async (target) => {
      await publishPackage(runtime.config.source, target, {
        dryRun: false,
        logger: this.logger,
        ...(runtime.config.manifestRewrite ? { manifestRewrite: runtime.config.manifestRewrite } : {}),
      });
    }));
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

async function loadProject(projectDir: string): Promise<{ debounceMs: number; packages: ResolvedLivePackage[] }> {
  const config = await loadConfig(path.join(projectDir, liveDirName, 'config.yaml'));
  return {
    debounceMs: config.debounceMs,
    packages: await resolveConfiguredPackages(config.packages, config.workspaces),
  };
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
    sendJson(response, 500, { error: formatUnknownError(error) });
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
