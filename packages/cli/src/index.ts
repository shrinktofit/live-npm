import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { request as createRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import chalk from 'chalk';
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
  shallowWatchPaths?: {
    root: string;
    target: string;
  }[];
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
      consoleLogger.info(formatFileAction('wrote', path.join(result.liveDir, 'pnpm-hooks.cjs')));
      consoleLogger.info(formatFileAction('wrote', path.join(result.liveDir, 'pnpmfile.cjs')));
      if (result.configCreated) {
        consoleLogger.info(formatFileAction('wrote', result.configPath));
      } else {
        consoleLogger.info(formatFileAction('kept', result.configPath));
      }
      if (result.createdRootPnpmfile && result.rootPnpmfilePath) {
        consoleLogger.info(formatFileAction('wrote', result.rootPnpmfilePath));
      } else if (result.rootPnpmfileAction === 'updated' && result.rootPnpmfilePath) {
        consoleLogger.info(formatFileAction('updated', result.rootPnpmfilePath));
      } else if (result.rootPnpmfilePath) {
        consoleLogger.info(formatFileAction('kept', result.rootPnpmfilePath));
      }
      consoleLogger.info(chalk.yellow('add .live-npm/ to your project .gitignore for local-only integration files.'));
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
  const watchGroups = status.watchGroups ?? [];
  const packages = status.packages ?? [];
  const totalWatchRoots = sumBy(watchGroups, (group) => group.watchPaths.length);
  const totalShallowRoots = sumBy(watchGroups, (group) => group.shallowWatchPaths?.length ?? 0);
  const totalWatchedDirs = sumBy(watchGroups, (group) => group.watchedDirs);
  const totalWatchedEntries = sumBy(watchGroups, (group) => group.watchedEntries);
  const errorCount = [
    ...watchGroups.map((group) => group.lastError),
    ...packages.map((statusPackage) => statusPackage.lastError),
  ].filter(Boolean).length;
  const lines = [
    `${chalk.bold.cyan('live-npm server')}  ${formatLabel('pid:')} ${formatValue(status.pid ?? 'unknown')}  ${formatHealth(errorCount)}`,
  ];

  for (const project of status.projects ?? []) {
    lines.push(`  ${formatLabel('project:')} ${formatPath(project)}`);
  }

  lines.push(
    '',
    `${formatSection('watch groups')}  ${formatMuted(`${watchGroups.length} ${plural(watchGroups.length, 'group')}, ${totalWatchRoots} ${plural(totalWatchRoots, 'root')}, ${totalWatchedDirs} ${plural(totalWatchedDirs, 'dir')}, ${totalWatchedEntries} ${plural(totalWatchedEntries, 'entry')}`)}`,
  );
  for (const group of watchGroups) {
    lines.push(`  ${formatKind(group.kind)} ${formatPath(group.root)} ${formatHealth(group.lastError ? 1 : 0)}`);
    lines.push(`    ${formatLabel('packages:')} ${formatPackageList(group.packages)}`);
    lines.push(`    ${formatLabel('watch roots:')} ${formatValue(group.watchPaths.length)}`);
    if (group.shallowWatchPaths?.length) {
      lines.push(`    ${formatLabel('shallow roots:')} ${formatValue(group.shallowWatchPaths.length)}`);
    }
    lines.push(`    ${formatLabel('watched dirs:')} ${formatValue(group.watchedDirs)}`);
    lines.push(`    ${formatLabel('watched entries:')} ${formatValue(group.watchedEntries)}`);
    if (group.lastError) {
      lines.push(`    ${formatErrorLabel('last error:')} ${chalk.red(group.lastError)}`);
    }
  }

  lines.push(
    '',
    `${formatSection('packages')}  ${formatMuted(`${packages.length} ${plural(packages.length, 'package')}, ${totalTargets(packages)} ${plural(totalTargets(packages), 'target')}, ${totalShallowRoots} shallow ${plural(totalShallowRoots, 'root')}`)}`,
  );
  for (const statusPackage of packages) {
    lines.push(`  ${formatPackageName(statusPackage.name)} ${formatHealth(statusPackage.lastError ? 1 : 0)}`);
    lines.push(`    ${formatLabel('source:')} ${formatPath(statusPackage.source)}`);
    lines.push(`    ${formatLabel('targets:')} ${formatValue(statusPackage.targets.length)}`);
    if (statusPackage.lastPublishAt) {
      lines.push(`    ${formatLabel('last publish:')} ${formatMuted(statusPackage.lastPublishAt)}`);
    }
    if (statusPackage.lastError) {
      lines.push(`    ${formatErrorLabel('last error:')} ${chalk.red(statusPackage.lastError)}`);
    }
  }

  return lines.join('\n');
}

function formatFileAction(action: 'kept' | 'updated' | 'wrote', filePath: string): string {
  const actionColor = action === 'wrote'
    ? chalk.green
    : action === 'updated'
      ? chalk.cyan
      : chalk.dim;
  return `${actionColor(action.padEnd(7))} ${formatPath(filePath)}`;
}

function formatHealth(errorCount: number): string {
  return errorCount > 0 ? chalk.red('error') : chalk.green('ok');
}

function formatKind(kind: string): string {
  return chalk.magenta(kind);
}

function formatLabel(label: string): string {
  return chalk.dim(label);
}

function formatErrorLabel(label: string): string {
  return chalk.red(label);
}

function formatMuted(value: string): string {
  return chalk.dim(value);
}

function formatPackageList(packages: string[]): string {
  if (packages.length === 0) {
    return formatMuted('-');
  }
  return packages.map(formatPackageName).join(formatMuted(', '));
}

function formatPackageName(packageName: string): string {
  return chalk.bold(packageName);
}

function formatPath(filePath: string): string {
  return chalk.dim(filePath);
}

function formatSection(label: string): string {
  return chalk.bold(label);
}

function formatValue(value: number | string): string {
  return chalk.cyan(String(value));
}

function plural(count: number, singular: string): string {
  if (count === 1) {
    return singular;
  }
  if (singular === 'entry') {
    return 'entries';
  }
  return `${singular}s`;
}

function sumBy<T>(items: T[], read: (item: T) => number): number {
  return items.reduce((sum, item) => sum + read(item), 0);
}

function totalTargets(packages: LiveNpmStatusPackage[]): number {
  return sumBy(packages, (statusPackage) => statusPackage.targets.length);
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
