import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
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
    });
    const serverUrl = new URL(server.url);
    await integrateProject({
      host: serverUrl.hostname,
      port: Number(serverUrl.port),
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
});

async function writeSourcePackage(source: string, contents: string): Promise<void> {
  await mkdir(path.join(source, 'lib'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    files: ['lib'],
    name: 'sample-package',
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
