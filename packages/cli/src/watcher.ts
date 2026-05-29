import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import { readManifest, getWatchPaths } from './package-plan.js';
import { publishPackage } from './publisher.js';
import type { LiveNpmPackageConfig } from './config.js';
import type { Logger } from './logger.js';

export interface WatchOptions {
  debounceMs: number;
  dryRun: boolean;
  logger: Logger;
}

export interface LiveWatcher {
  close(): Promise<void>;
}

export async function watchPackages(packages: LiveNpmPackageConfig[], options: WatchOptions): Promise<LiveWatcher> {
  const watchers: FSWatcher[] = [];

  for (const packageConfig of packages) {
    await publishPackage(packageConfig.source, packageConfig.target, {
      ...options,
      ...(packageConfig.manifestRewrite ? { manifestRewrite: packageConfig.manifestRewrite } : {}),
    });
    const manifest = await readManifest(packageConfig.source);
    const watchPaths = [
      ...getWatchPaths(packageConfig.source, manifest),
      ...(packageConfig.extraWatchPaths ?? []),
    ];
    const label = `${packageConfig.source} -> ${packageConfig.target}`;
    options.logger.info(`watching ${label}`);

    const schedule = debounce(async () => {
      try {
        await publishPackage(packageConfig.source, packageConfig.target, {
          ...options,
          ...(packageConfig.manifestRewrite ? { manifestRewrite: packageConfig.manifestRewrite } : {}),
        });
      } catch (error) {
        options.logger.error(formatUnknownError(error));
      }
    }, options.debounceMs);

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
      options.logger.debug(`${event} ${path.relative(packageConfig.source, changedPath)}`);
      schedule();
    });

    watcher.on('error', (error) => {
      options.logger.error(formatUnknownError(error));
    });

    watchers.push(watcher);
  }

  return {
    async close() {
      await Promise.all(watchers.map((watcher) => watcher.close()));
    },
  };
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
