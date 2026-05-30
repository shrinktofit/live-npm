import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { request as createRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import yargs from 'yargs/yargs';
import { consoleLogger } from './logger.js';
import { integrateProject } from './integrate.js';
import { startLiveNpmServer } from './server.js';

export { loadConfig } from './config.js';
export type { LiveNpmConfig, LiveNpmPackageConfig } from './config.js';
export { integrateProject } from './integrate.js';
export { startLiveNpmServer } from './server.js';
export { resolveWorkspacePackageConfigs } from './workspace.js';

interface ServerState {
  pid: number;
  projectDir: string;
  token: string;
  url: string;
}

interface LiveNpmStatus {
  packages?: LiveNpmStatusPackage[];
  pid?: number;
  projects?: string[];
  watchGroups?: LiveNpmStatusWatchGroup[];
}

interface LiveNpmStatusPackage {
  lastError?: string;
  lastPublishAt?: string;
  name: string;
  source: string;
  targets: string[];
  watchGroupKey: string;
}

interface LiveNpmStatusWatchGroup {
  key: string;
  kind: string;
  lastError?: string;
  packages: string[];
  root: string;
  watchedDirs: number;
  watchedEntries: number;
  watchPaths: string[];
}

export async function runCli(args: string[]): Promise<void> {
  const version = await readVersion();
  await yargs()
    .scriptName('live-npm')
    .usage('$0 <command>')
    .command('start', 'Start the live-npm local server', (command) => command
      .option('host', {
        type: 'string',
        default: '127.0.0.1',
        describe: 'Server host',
      })
      .option('port', {
        type: 'number',
        default: 0,
        describe: 'Server port. Defaults to the previous project port, or any available port.',
      })
      .option('project', {
        type: 'string',
        array: true,
        describe: 'Project directory whose .live-npm/state.json should be restored',
      }), async (argv) => {
      const server = await startLiveNpmServer({
        host: argv.host,
        logger: consoleLogger,
        port: argv.port,
        projectDirs: argv.project?.length ? argv.project : [process.cwd()],
      });
      await waitForClose(async () => {
        await server.close();
      });
    })
    .command('integrate', 'Generate pnpm hook files for the current project', (command) => command
      .strict(), async () => {
      const result = await integrateProject({
        projectDir: process.cwd(),
      });
      consoleLogger.info(`wrote ${path.join(result.liveDir, 'pnpm-hooks.cjs')}`);
      consoleLogger.info(`wrote ${path.join(result.liveDir, 'pnpmfile.cjs')}`);
      if (result.configCreated) {
        consoleLogger.info(`wrote ${result.configPath}`);
      } else {
        consoleLogger.info(`kept existing ${result.configPath}`);
      }
      if (result.createdRootPnpmfile && result.rootPnpmfilePath) {
        consoleLogger.info(`wrote ${result.rootPnpmfilePath}`);
      } else if (result.rootPnpmfileAction === 'updated' && result.rootPnpmfilePath) {
        consoleLogger.info(`updated ${result.rootPnpmfilePath}`);
      } else if (result.rootPnpmfilePath) {
        consoleLogger.info(`kept existing ${result.rootPnpmfilePath}`);
      }
      consoleLogger.info('add .live-npm/ to your project .gitignore for local-only integration files.');
    })
    .command('status', 'Print live-npm server status for a project', (command) => command
      .option('project', {
        type: 'string',
        default: process.cwd(),
        describe: 'Project directory containing .live-npm/server.json',
      })
      .option('json', {
        type: 'boolean',
        default: false,
        describe: 'Print raw JSON status',
      })
      .strict(), async (argv) => {
      const status = await readProjectStatus(path.resolve(argv.project));
      if (argv.json) {
        consoleLogger.info(JSON.stringify(status, null, 2));
        return;
      }
      consoleLogger.info(formatStatus(status));
    })
    .version('version', 'Print version', version)
    .alias('version', 'v')
    .help('help')
    .alias('help', 'h')
    .demandCommand(1, 'Choose a command: start, integrate, or status.')
    .strict()
    .exitProcess(false)
    .parseAsync(args);
}

async function readVersion(): Promise<string> {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
}

async function readProjectStatus(projectDir: string): Promise<LiveNpmStatus> {
  const serverState = await readServerState(projectDir);
  return await requestStatus(serverState);
}

async function readServerState(projectDir: string): Promise<ServerState> {
  const serverPath = path.join(projectDir, '.live-npm/server.json');
  try {
    return JSON.parse(await readFile(serverPath, 'utf8')) as ServerState;
  } catch (error) {
    throw new Error(`Could not read ${serverPath}. Is live-npm start running for this project?`, { cause: error });
  }
}

async function requestStatus(serverState: ServerState): Promise<LiveNpmStatus> {
  const url = new URL('/status', serverState.url);
  return await new Promise((resolve, reject) => {
    const request = createRequest({
      headers: {
        'x-live-npm-token': serverState.token,
      },
      host: url.hostname,
      method: 'GET',
      path: url.pathname,
      port: url.port,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(text || `live-npm status request failed with ${response.statusCode}`));
          return;
        }
        resolve(JSON.parse(text) as LiveNpmStatus);
      });
    });
    request.on('error', (error) => {
      reject(new Error(`Could not reach live-npm server at ${serverState.url}: ${error.message}`));
    });
    request.end();
  });
}

function formatStatus(status: LiveNpmStatus): string {
  const lines = [
    'live-npm server',
    `  pid: ${status.pid ?? 'unknown'}`,
  ];

  for (const project of status.projects ?? []) {
    lines.push(`  project: ${project}`);
  }

  lines.push('', 'watch groups');
  for (const group of status.watchGroups ?? []) {
    lines.push(`  ${group.kind}: ${group.root}`);
    lines.push(`    packages: ${group.packages.join(', ') || '-'}`);
    lines.push(`    watch roots: ${group.watchPaths.length}`);
    lines.push(`    watched dirs: ${group.watchedDirs}`);
    lines.push(`    watched entries: ${group.watchedEntries}`);
    if (group.lastError) {
      lines.push(`    last error: ${group.lastError}`);
    }
  }

  lines.push('', 'packages');
  for (const statusPackage of status.packages ?? []) {
    lines.push(`  ${statusPackage.name}`);
    lines.push(`    source: ${statusPackage.source}`);
    lines.push(`    targets: ${statusPackage.targets.length}`);
    if (statusPackage.lastPublishAt) {
      lines.push(`    last publish: ${statusPackage.lastPublishAt}`);
    }
    if (statusPackage.lastError) {
      lines.push(`    last error: ${statusPackage.lastError}`);
    }
  }

  return lines.join('\n');
}

async function waitForClose(close: () => Promise<void>): Promise<void> {
  let closing = false;
  const closeOnce = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await close();
  };

  await new Promise<void>((resolve) => {
    const closeAndResolve = () => {
      void closeOnce().then(resolve);
    };
    process.once('SIGINT', closeAndResolve);
    process.once('SIGTERM', closeAndResolve);
  });
}
