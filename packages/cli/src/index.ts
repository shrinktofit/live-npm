import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import yargs from 'yargs/yargs';
import { consoleLogger } from './logger.js';
import { integrateProject } from './integrate.js';
import { publishPackage } from './publisher.js';
import { startLiveNpmServer } from './server.js';
import { watchPackages, type WatchPackageConfig } from './watcher.js';
import { resolveConfiguredPackages } from './workspace.js';
import { loadConfig } from './config.js';

export { loadConfig } from './config.js';
export type { LiveNpmConfig, LiveNpmPackageConfig } from './config.js';
export { integrateProject } from './integrate.js';
export { publishPackage } from './publisher.js';
export type { PublishResult } from './publisher.js';
export { startLiveNpmServer } from './server.js';
export { watchPackages } from './watcher.js';
export type { LiveWatcher } from './watcher.js';
export { resolveWorkspacePackageConfigs } from './workspace.js';

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
        default: 8456,
        describe: 'Server port',
      }), async (argv) => {
      const server = await startLiveNpmServer({
        host: argv.host,
        logger: consoleLogger,
        port: argv.port,
      });
      await waitForClose(async () => {
        await server.close();
      });
    })
    .command('integrate', 'Generate pnpm hook files for the current project', (command) => command
      .option('host', {
        type: 'string',
        default: '127.0.0.1',
        describe: 'Default server host written into .live-npm/pnpm-hooks.cjs',
      })
      .option('port', {
        type: 'number',
        default: 8456,
        describe: 'Default server port written into .live-npm/pnpm-hooks.cjs',
      }), async (argv) => {
      const result = await integrateProject({
        host: argv.host,
        port: argv.port,
        projectDir: process.cwd(),
      });
      consoleLogger.info(`wrote ${path.join(result.liveDir, 'pnpm-hooks.cjs')}`);
      consoleLogger.info(`wrote ${path.join(result.liveDir, 'pnpmfile.cjs')}`);
      if (result.createdRootPnpmfile && result.rootPnpmfilePath) {
        consoleLogger.info(`wrote ${result.rootPnpmfilePath}`);
      } else if (result.rootPnpmfilePath && result.snippetPath) {
        consoleLogger.warn(`${result.rootPnpmfilePath} already exists; merge ${result.snippetPath} manually.`);
      }
      consoleLogger.info('add .live-npm/ to your project .gitignore for local-only integration files.');
    })
    .command('once <target>', 'Publish configured packages once into a target node_modules root', (command) => command
      .positional('target', {
        type: 'string',
        describe: 'Target node_modules-style root',
      })
      .option('config', {
        alias: 'c',
        type: 'string',
        default: path.join('.live-npm', 'config.yaml'),
        describe: 'YAML config path',
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'Print what would be published without writing files',
      }), async (argv) => {
      const packages = await readTargetPackages(argv.config ?? path.join('.live-npm', 'config.yaml'), readRequiredTarget(argv.target));
      for (const packageConfig of packages) {
        await publishPackage(packageConfig.source, packageConfig.target, {
          dryRun: argv.dryRun ?? false,
          logger: consoleLogger,
          ...(packageConfig.manifestRewrite ? { manifestRewrite: packageConfig.manifestRewrite } : {}),
        });
      }
    })
    .command('watch <target>', 'Publish configured packages and keep a target node_modules root fresh', (command) => command
      .positional('target', {
        type: 'string',
        describe: 'Target node_modules-style root',
      })
      .option('config', {
        alias: 'c',
        type: 'string',
        default: path.join('.live-npm', 'config.yaml'),
        describe: 'YAML config path',
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        describe: 'Print what would be published without writing files',
      }), async (argv) => {
      const configPath = argv.config ?? path.join('.live-npm', 'config.yaml');
      const config = await loadConfig(configPath);
      const packages = await readTargetPackages(configPath, readRequiredTarget(argv.target));
      const watcher = await watchPackages(packages, {
        debounceMs: config.debounceMs,
        dryRun: argv.dryRun ?? false,
        logger: consoleLogger,
      });
      await waitForClose(async () => {
        await watcher.close();
      });
    })
    .version('version', 'Print version', version)
    .alias('version', 'v')
    .help('help')
    .alias('help', 'h')
    .demandCommand(1, 'Choose a command: start, integrate, once, or watch.')
    .strict()
    .exitProcess(false)
    .parseAsync(args);
}

async function readVersion(): Promise<string> {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
}

async function readTargetPackages(configPath: string, targetRoot: string): Promise<WatchPackageConfig[]> {
  const config = await loadConfig(configPath);
  const packages = await resolveConfiguredPackages(config.packages, config.workspaces);
  return packages.map((packageConfig) => ({
    ...packageConfig,
    target: path.join(path.resolve(targetRoot), ...packageConfig.name.split('/')),
  }));
}

function readRequiredTarget(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('target must be a non-empty string.');
  }
  return value;
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
