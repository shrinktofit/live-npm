import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import type { ArgumentsCamelCase } from 'yargs';
import yargs from 'yargs/yargs';
import { loadConfig } from './config.js';
import { consoleLogger } from './logger.js';
import { publishPackage } from './publisher.js';
import { watchPackages } from './watcher.js';
import { resolveConfiguredPackages } from './workspace.js';

export { loadConfig } from './config.js';
export type { LiveNpmConfig, LiveNpmPackageConfig } from './config.js';
export { publishPackage } from './publisher.js';
export type { PublishResult } from './publisher.js';
export { watchPackages } from './watcher.js';
export type { LiveWatcher } from './watcher.js';
export { resolveWorkspacePackageConfigs } from './workspace.js';

interface CliOptions {
  config: string;
  dryRun: boolean;
  once: boolean;
}

export async function runCli(args: string[]): Promise<void> {
  const version = await readVersion();
  const options = await parseCliOptions(args, version);
  if (!options) {
    return;
  }

  const config = await loadConfig(options.config);
  const packages = await resolveConfiguredPackages(config.packages, config.workspaces);

  if (options.once) {
    for (const packageConfig of packages) {
      await publishPackage(packageConfig.source, packageConfig.target, {
        dryRun: options.dryRun,
        logger: consoleLogger,
        ...(packageConfig.manifestRewrite ? { manifestRewrite: packageConfig.manifestRewrite } : {}),
      });
    }
    return;
  }

  const watcher = await watchPackages(packages, {
    debounceMs: config.debounceMs,
    dryRun: options.dryRun,
    logger: consoleLogger,
  });

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await watcher.close();
  };

  await new Promise<void>((resolve) => {
    const closeAndResolve = () => {
      void close().then(resolve);
    };
    process.once('SIGINT', closeAndResolve);
    process.once('SIGTERM', closeAndResolve);
  });
}

async function parseCliOptions(args: string[], version: string): Promise<CliOptions | undefined> {
  const parser = yargs()
    .scriptName('live-npm')
    .usage('$0 [options]')
    .option('config', {
      alias: 'c',
      type: 'string',
      default: 'live-npm.yaml',
      describe: 'YAML config path',
    })
    .option('once', {
      type: 'boolean',
      default: false,
      describe: 'Publish once and exit',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Print what would be published without writing files',
    })
    .version('version', 'Print version', version)
    .alias('version', 'v')
    .help('help')
    .alias('help', 'h')
    .strict()
    .exitProcess(false);

  return new Promise((resolve, reject) => {
    void parser.parseAsync(args, {}, (error, argv, output) => {
      if (output) {
        console.log(output.trimEnd());
      }

      if (error) {
        reject(error);
        return;
      }

      if (output) {
        resolve(undefined);
        return;
      }

      const options = argv as ArgumentsCamelCase<Partial<CliOptions>>;
      resolve({
        config: options.config ?? 'live-npm.yaml',
        dryRun: options.dryRun ?? false,
        once: options.once ?? false,
      });
    }).catch(reject);
  });
}

async function readVersion(): Promise<string> {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: string };
  return packageJson.version ?? '0.0.0';
}
