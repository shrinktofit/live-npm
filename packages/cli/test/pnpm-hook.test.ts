import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { integrateProject } from '../src/integrate.js';
import { silentLogger } from '../src/logger.js';
import { startLiveNpmServer, type LiveNpmServer } from '../src/server.js';

const require = createRequire(import.meta.url);

describe('generated pnpm hooks', () => {
  let server: LiveNpmServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('resolves, fetches, imports, and keeps the imported target live', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'node_modules/.pnpm/live/node_modules/sample-package');
    await writeSourcePackage(source, 'export const value = 1;\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      dependencies: {
        'sample-package': 'live:sample-package',
      },
      name: 'consumer',
      packageManager: 'pnpm@11.4.0',
    }, null, 2));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });
    await integrateProject({
      projectDir: root,
    });
    await writeFile(path.join(root, '.live-npm/config.yaml'), [
      'debounceMs: 25',
      'packages:',
      '  - source: ../source',
      '',
    ].join('\n'));

    const hooks = require(path.join(root, '.live-npm/pnpm-hooks.cjs')) as {
      fetcher: {
        fetch(cafs: unknown, resolution: unknown, options: unknown): Promise<{ filesMap: Map<string, string> }>;
      };
      importPackage(destinationDir: string, options: { filesMap: Map<string, string> }): Promise<string>;
      resolver: {
        resolve(wantedDependency: unknown, options: unknown): Promise<{ resolution: unknown }>;
      };
    };

    const resolved = await hooks.resolver.resolve({ bareSpecifier: 'live:sample-package' }, { lockfileDir: root });
    const fetched = await hooks.fetcher.fetch(undefined, resolved.resolution, { lockfileDir: root });
    await expect(hooks.importPackage(target, { filesMap: fetched.filesMap })).resolves.toBe('copy');
    await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 1');

    await writeSourcePackage(source, 'export const value = 2;\n');
    await waitFor(async () => {
      await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 2');
    });
  });

  it('registers scoped package imports and keeps them live', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const packageName = '@scope/sample-package';
    const target = path.join(root, 'node_modules/.pnpm/live/node_modules/@scope/sample-package');
    await writeSourcePackage(source, 'export const value = 1;\n', packageName);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      dependencies: {
        [packageName]: `live:${packageName}`,
      },
      name: 'consumer',
      packageManager: 'pnpm@11.4.0',
    }, null, 2));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });
    await integrateProject({
      projectDir: root,
    });
    await writeFile(path.join(root, '.live-npm/config.yaml'), [
      'debounceMs: 25',
      'packages:',
      '  - source: ../source',
      '',
    ].join('\n'));

    const hooks = require(path.join(root, '.live-npm/pnpm-hooks.cjs')) as {
      fetcher: {
        fetch(cafs: unknown, resolution: unknown, options: unknown): Promise<{ filesMap: Map<string, string> }>;
      };
      importPackage(destinationDir: string, options: { filesMap: Map<string, string> }): Promise<string>;
      resolver: {
        resolve(wantedDependency: unknown, options: unknown): Promise<{ normalizedBareSpecifier: string; resolution: unknown }>;
      };
    };

    const resolved = await hooks.resolver.resolve({ bareSpecifier: `live:${packageName}` }, { lockfileDir: root });
    expect(resolved.normalizedBareSpecifier).toBe(`live:${packageName}`);
    const fetched = await hooks.fetcher.fetch(undefined, resolved.resolution, { lockfileDir: root });
    await expect(hooks.importPackage(target, { filesMap: fetched.filesMap })).resolves.toBe('copy');
    await expect(readFile(path.join(root, '.live-npm/state.json'), 'utf8')).resolves.toContain(packageName);

    await writeSourcePackage(source, 'export const value = 2;\n', packageName);
    await waitFor(async () => {
      await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 2');
    });
  });

  it('can use explicit server environment overrides instead of server.json', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    await writeSourcePackage(source, 'export const value = 1;\n');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      dependencies: {
        'sample-package': 'live:sample-package',
      },
      name: 'consumer',
      packageManager: 'pnpm@11.4.0',
    }, null, 2));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });
    await integrateProject({
      projectDir: root,
    });
    await writeFile(path.join(root, '.live-npm/config.yaml'), [
      'debounceMs: 25',
      'packages:',
      '  - source: ../source',
      '',
    ].join('\n'));

    const serverState = JSON.parse(await readFile(path.join(root, '.live-npm/server.json'), 'utf8')) as {
      token: string;
    };
    await rm(path.join(root, '.live-npm/server.json'), { force: true });
    const previousUrl = process.env.LIVE_NPM_URL;
    const previousToken = process.env.LIVE_NPM_TOKEN;
    process.env.LIVE_NPM_URL = server.url;
    process.env.LIVE_NPM_TOKEN = serverState.token;

    try {
      const hooks = require(path.join(root, '.live-npm/pnpm-hooks.cjs')) as {
        resolver: {
          resolve(wantedDependency: unknown, options: unknown): Promise<{ normalizedBareSpecifier: string }>;
        };
      };

      await expect(hooks.resolver.resolve(
        { bareSpecifier: 'live:sample-package' },
        { lockfileDir: root },
      )).resolves.toMatchObject({
        normalizedBareSpecifier: 'live:sample-package',
      });
    } finally {
      restoreEnv('LIVE_NPM_URL', previousUrl);
      restoreEnv('LIVE_NPM_TOKEN', previousToken);
    }
  });

  it('fails clearly when the project server file is missing', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      dependencies: {
        'sample-package': 'live:sample-package',
      },
      name: 'consumer',
      packageManager: 'pnpm@11.4.0',
    }, null, 2));
    await integrateProject({
      projectDir: root,
    });

    const hooks = require(path.join(root, '.live-npm/pnpm-hooks.cjs')) as {
      resolver: {
        resolve(wantedDependency: unknown, options: unknown): Promise<unknown>;
      };
    };

    await expect(hooks.resolver.resolve(
      { bareSpecifier: 'live:sample-package' },
      { lockfileDir: root },
    )).rejects.toThrow('Start live-npm for this project before running pnpm install');
  });

  it('fails clearly when no live sources are configured', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      dependencies: {
        'sample-package': 'live:sample-package',
      },
      name: 'consumer',
      packageManager: 'pnpm@11.4.0',
    }, null, 2));
    await integrateProject({
      projectDir: root,
    });

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    const hooks = require(path.join(root, '.live-npm/pnpm-hooks.cjs')) as {
      resolver: {
        resolve(wantedDependency: unknown, options: unknown): Promise<unknown>;
      };
    };

    await expect(hooks.resolver.resolve(
      { bareSpecifier: 'live:sample-package' },
      { lockfileDir: root },
    )).rejects.toThrow(`live-npm cannot resolve live:sample-package because ${path.join(root, '.live-npm/config.yaml')} has no source packages or workspaces configured`);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function writeSourcePackage(source: string, contents: string, packageName = 'sample-package'): Promise<void> {
  await mkdir(path.join(source, 'lib'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    files: ['lib'],
    name: packageName,
    version: '0.0.0',
  }, null, 2));
  await writeFile(path.join(source, 'lib/index.js'), contents);
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  const timeoutAt = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < timeoutAt) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
  throw lastError;
}

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'live-npm-'));
}
