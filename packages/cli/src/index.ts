import { readFile } from 'node:fs/promises';
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
    .version('version', 'Print version', version)
    .alias('version', 'v')
    .help('help')
    .alias('help', 'h')
    .demandCommand(1, 'Choose a command: start or integrate.')
    .strict()
    .exitProcess(false)
    .parseAsync(args);
}

async function readVersion(): Promise<string> {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
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
