import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublishWatchIgnored, getWatchPaths } from '../src/package-plan.js';

describe('getWatchPaths', () => {
  it('normalizes globbed package.json#files entries to chokidar-compatible roots', async () => {
    const source = await makePackageDir();
    await mkdir(path.join(source, 'lib/font'), { recursive: true });

    const paths = normalizePaths(getWatchPaths(source, {
      files: [
        'lib/**',
        '!lib/**/*.map',
      ],
    }));

    expect(paths).toContain(normalizePath(path.join(source, 'lib')));
    expect(paths).not.toContain(normalizePath(path.join(source, 'lib/**')));
    expect(paths.every((watchPath) => !watchPath.includes('!'))).toBe(true);
  });

  it('folds child watch paths into their parent watch root', async () => {
    const source = await makePackageDir();
    await mkdir(path.join(source, 'lib/font'), { recursive: true });

    const paths = normalizePaths(getWatchPaths(source, {
      files: [
        'lib/**',
        'lib/font/**',
      ],
    }));

    expect(paths).toContain(normalizePath(path.join(source, 'lib')));
    expect(paths).not.toContain(normalizePath(path.join(source, 'lib/font')));
  });

  it('does not create package-root watch paths when files contains only exclusions', async () => {
    const source = await makePackageDir();
    await mkdir(path.join(source, 'bin'), { recursive: true });
    await writeFile(path.join(source, 'main.cjs'), 'module.exports = {};\n');
    await writeFile(path.join(source, 'bin/cli.cjs'), '#!/usr/bin/env node\n');

    const paths = normalizePaths(getWatchPaths(source, {
      bin: {
        sample: 'bin/cli.cjs',
      },
      files: [
        '!lib/xxx',
      ],
      main: 'main.cjs',
    }));

    expect(paths).toContain(normalizePath(path.join(source, 'package.json')));
    expect(paths).toContain(normalizePath(path.join(source, 'main.cjs')));
    expect(paths).toContain(normalizePath(path.join(source, 'bin/cli.cjs')));
    expect(paths).not.toContain(normalizePath(source));
    expect(paths.every((watchPath) => !watchPath.includes('!'))).toBe(true);
  });

  it('falls back to the nearest existing parent for future build output directories', async () => {
    const source = await makePackageDir();

    const paths = normalizePaths(getWatchPaths(source, {
      files: [
        'dist/**',
      ],
    }));

    expect(paths).toContain(normalizePath(source));
    expect(paths).not.toContain(normalizePath(path.join(source, 'dist')));
  });

  it('keeps existing literal files as exact watch paths', async () => {
    const source = await makePackageDir();
    await mkdir(path.join(source, 'lib'), { recursive: true });
    await writeFile(path.join(source, 'lib/index.js'), 'export {};\n');

    const paths = normalizePaths(getWatchPaths(source, {
      files: [
        'lib/index.js',
      ],
    }));

    expect(paths).toContain(normalizePath(path.join(source, 'lib/index.js')));
  });

  it('ignores files that npm never includes even when files names them', async () => {
    const source = await makePackageDir();
    const ignored = createPublishWatchIgnored(source, {
      files: [
        'node_modules/left-pad/index.js',
        '.npmrc',
        'package-lock.json',
      ],
    });

    expect(ignored(path.join(source, 'node_modules/left-pad/index.js'))).toBe(true);
    expect(ignored(path.join(source, '.npmrc'))).toBe(true);
    expect(ignored(path.join(source, 'package-lock.json'))).toBe(true);
  });

  it('ignores npm default ignored files unless package.json#files explicitly includes them', async () => {
    const source = await makePackageDir();

    expect(createPublishWatchIgnored(source, {})(
      path.join(source, '.DS_Store'),
    )).toBe(true);
    expect(createPublishWatchIgnored(source, {
      files: [
        '.DS_Store',
        '*.orig',
      ],
    })(
      path.join(source, '.DS_Store'),
    )).toBe(false);
    expect(createPublishWatchIgnored(source, {
      files: [
        '.DS_Store',
        '*.orig',
      ],
    })(
      path.join(source, 'patch.orig'),
    )).toBe(false);
  });

  it('lets package.json, readme/license, main, and bin files survive negative files entries', async () => {
    const source = await makePackageDir();
    const ignored = createPublishWatchIgnored(source, {
      bin: 'bin/cli.cjs',
      files: [
        '!package.json',
        '!README.md',
        '!LICENSE.txt',
        '!main.cjs',
        '!bin/cli.cjs',
      ],
      main: 'main.cjs',
    });

    expect(ignored(path.join(source, 'package.json'))).toBe(false);
    expect(ignored(path.join(source, 'README.md'))).toBe(false);
    expect(ignored(path.join(source, 'LICENSE.txt'))).toBe(false);
    expect(ignored(path.join(source, 'main.cjs'))).toBe(false);
    expect(ignored(path.join(source, 'bin/cli.cjs'))).toBe(false);
  });

  it('uses negative files entries to ignore matching publish paths', async () => {
    const source = await makePackageDir();
    const ignored = createPublishWatchIgnored(source, {
      files: [
        'lib/**',
        '!lib/**/*.map',
      ],
    });

    expect(ignored(path.join(source, 'lib/index.js'))).toBe(false);
    expect(ignored(path.join(source, 'lib/index.js.map'))).toBe(true);
    expect(ignored(path.join(source, 'lib/font/index.js.map'))).toBe(true);
  });

  it('matches npm publish ignore behavior in a mixed package fixture', async () => {
    const source = await makePackageDir();
    await mkdir(path.join(source, '.git'), { recursive: true });
    await mkdir(path.join(source, '.hg'), { recursive: true });
    await mkdir(path.join(source, '.svn'), { recursive: true });
    await mkdir(path.join(source, 'bin'), { recursive: true });
    await mkdir(path.join(source, 'CVS'), { recursive: true });
    await mkdir(path.join(source, 'node_modules/left-pad'), { recursive: true });
    await mkdir(path.join(source, 'logs'), { recursive: true });
    await writeFile(path.join(source, 'README.zh-CN.md'), '# readme\n');
    await writeFile(path.join(source, 'license.custom'), 'license\n');
    await writeFile(path.join(source, 'main.cjs'), 'module.exports = {};\n');
    await writeFile(path.join(source, 'bin/cli.cjs'), '#!/usr/bin/env node\n');

    const ignored = createPublishWatchIgnored(source, {
      bin: {
        sample: 'bin/cli.cjs',
      },
      files: [
        '.DS_Store',
        '._metadata',
        '.cache.swp',
        '.hg/keep.txt',
        '.svn/keep.txt',
        '.lock-wscript',
        '.wafpickle-7',
        'CVS/keep.txt',
        'config.gypi',
        'logs/npm-debug.log',
        'patch.orig',
        '.git/config',
        '.npmrc',
        'bun.lockb',
        'node_modules/left-pad/index.js',
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        '!README.zh-CN.md',
        '!license.custom',
        '!main.cjs',
        '!bin/cli.cjs',
      ],
      main: 'main.cjs',
    });

    const explicitlyIncludedDefaultIgnored = [
      '.DS_Store',
      '._metadata',
      '.cache.swp',
      '.hg/keep.txt',
      '.svn/keep.txt',
      '.lock-wscript',
      '.wafpickle-7',
      'CVS/keep.txt',
      'config.gypi',
      'logs/npm-debug.log',
      'patch.orig',
    ];
    for (const relativePath of explicitlyIncludedDefaultIgnored) {
      expect(ignored(path.join(source, ...relativePath.split('/'))), relativePath).toBe(false);
    }

    const neverIncluded = [
      '.git/config',
      '.npmrc',
      'bun.lockb',
      'node_modules/left-pad/index.js',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
    ];
    for (const relativePath of neverIncluded) {
      expect(ignored(path.join(source, ...relativePath.split('/'))), relativePath).toBe(true);
    }

    for (const relativePath of [
      'package.json',
      'README.zh-CN.md',
      'license.custom',
      'main.cjs',
      'bin/cli.cjs',
    ]) {
      expect(ignored(path.join(source, ...relativePath.split('/'))), relativePath).toBe(false);
    }
  });
});

async function makePackageDir(): Promise<string> {
  const source = await mkdtemp(path.join(os.tmpdir(), 'live-npm-watch-'));
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: 'sample-package',
    version: '0.0.0',
  }, null, 2));
  return source;
}

function normalizePaths(paths: string[]): string[] {
  return paths.map(normalizePath);
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}
