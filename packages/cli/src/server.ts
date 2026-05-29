import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
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

export interface LiveNpmServerOptions {
  host: string;
  logger?: Logger;
  port: number;
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

export async function startLiveNpmServer(options: LiveNpmServerOptions): Promise<LiveNpmServer> {
  const manager = new LiveNpmServerManager(options.logger ?? consoleLogger);
  const server = createServer((request, response) => {
    void handleRequest(manager, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${options.host}:${actualPort}`;
  options.logger?.info(`live-npm server listening on ${url}`);

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
    },
    url,
  };
}

class LiveNpmServerManager {
  private readonly logger: Logger;
  private readonly runtimes = new Map<string, RuntimePackage>();

  constructor(logger: Logger) {
    this.logger = logger;
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
    return {
      packageName: runtime.config.name,
      targets: [...runtime.targets],
    };
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

  private async readPublishedManifest(config: ResolvedLivePackage): Promise<unknown> {
    const manifest = await readManifest(config.source);
    if (!config.manifestRewrite) {
      return manifest;
    }
    return rewritePublishManifest(manifest, config.manifestRewrite);
  }
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
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed.' });
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

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
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
