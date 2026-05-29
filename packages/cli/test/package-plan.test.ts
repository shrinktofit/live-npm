import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getWatchPaths } from '../src/package-plan.js';

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

  it('falls back to the package root when files contains only exclusions', async () => {
    const source = await makePackageDir();

    const paths = normalizePaths(getWatchPaths(source, {
      files: [
        '!lib/xxx',
      ],
    }));

    expect(paths).toContain(normalizePath(source));
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
