import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/logger.js';
import { startLiveNpmServer, type LiveNpmServer } from '../src/server.js';

describe('startLiveNpmServer', () => {
  let server: LiveNpmServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('publishes and keeps registered import targets live', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'node_modules/.pnpm/live/node_modules/sample-package');
    await writeSourcePackage(source, 'export const value = 1;\n');
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), [
      'debounceMs: 25',
      'packages:',
      '  - source: ../source',
      '',
    ].join('\n'));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
    });

    await postJson(server.url, '/fetch', {
      packageName: 'sample-package',
      projectDir: root,
    });
    await postJson(server.url, '/register-import', {
      destinationDir: target,
      packageName: 'sample-package',
      projectDir: root,
    });

    await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 1');

    await writeSourcePackage(source, 'export const value = 2;\n');
    await waitFor(async () => {
      await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 2');
    });
  });

  it('restores persisted import targets after server restart', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'node_modules/.pnpm/live/node_modules/sample-package');
    await writeSourcePackage(source, 'export const value = 1;\n');
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), [
      'debounceMs: 25',
      'packages:',
      '  - source: ../source',
      '',
    ].join('\n'));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
    });
    await postJson(server.url, '/register-import', {
      destinationDir: target,
      packageName: 'sample-package',
      projectDir: root,
    });
    await server.close();
    server = undefined;

    await writeSourcePackage(source, 'export const value = 2;\n');
    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 2');
    await expect(readFile(path.join(root, '.live-npm/state.json'), 'utf8')).resolves.toContain('sample-package');
  });
});

async function postJson(baseUrl: string, pathname: string, body: unknown): Promise<unknown> {
  const url = new URL(pathname, baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const request = http.request({
      headers: {
        'content-length': String(payload.byteLength),
        'content-type': 'application/json',
      },
      host: url.hostname,
      method: 'POST',
      path: url.pathname,
      port: url.port,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(text));
          return;
        }
        resolve(JSON.parse(text) as unknown);
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function writeSourcePackage(source: string, contents: string): Promise<void> {
  await mkdir(path.join(source, 'lib'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: 'sample-package',
    version: '0.0.0',
    files: ['lib'],
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
