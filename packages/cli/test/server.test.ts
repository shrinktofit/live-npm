import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger, type Logger } from '../src/logger.js';
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
      projectDirs: [root],
    });

    await postJson(server.url, '/fetch', {
      packageName: 'sample-package',
      projectDir: root,
    }, root);
    await postJson(server.url, '/register-import', {
      destinationDir: target,
      packageName: 'sample-package',
      projectDir: root,
    }, root);

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
      projectDirs: [root],
    });
    await postJson(server.url, '/register-import', {
      destinationDir: target,
      packageName: 'sample-package',
      projectDir: root,
    }, root);
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

  it('warns when a project has config but no persisted state', async () => {
    const root = await makeTempDir();
    const warnings: string[] = [];
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: createTestLogger(warnings),
      port: 0,
      projectDirs: [root],
    });

    expect(warnings.join('\n')).toContain('No ');
    expect(warnings.join('\n')).toContain('state.json');
    expect(warnings.join('\n')).toContain('Run pnpm install once');
  });

  it('writes server endpoint state and rejects a second running server for the same project', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    const serverState = JSON.parse(await readFile(path.join(root, '.live-npm/server.json'), 'utf8')) as {
      token: string;
      url: string;
    };
    expect(serverState.url).toBe(server.url);
    expect(serverState.token).not.toBe('');
    await expect(startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    })).rejects.toThrow('already running');
  });

  it('reuses the previous port when possible and falls back if it is occupied', async () => {
    const root = await makeTempDir();
    const warnings: string[] = [];
    const occupiedServer = http.createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const occupiedPort = await listenOnRandomPort(occupiedServer);
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');
    await writeFile(path.join(root, '.live-npm/server.json'), JSON.stringify({
      pid: 1,
      projectDir: root,
      startedAt: new Date().toISOString(),
      token: 'stale-token',
      url: `http://127.0.0.1:${occupiedPort}`,
      version: 1,
    }, null, 2));

    try {
      server = await startLiveNpmServer({
        host: '127.0.0.1',
        logger: createTestLogger(warnings),
        port: 0,
        projectDirs: [root],
      });

      expect(server.url).not.toBe(`http://127.0.0.1:${occupiedPort}`);
      expect(warnings.join('\n')).toContain('Previous live-npm port');
      expect(warnings.join('\n')).toContain('reinstall is not required');
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupiedServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});

function createTestLogger(warnings: string[]): Logger {
  return {
    debug() {
      return undefined;
    },
    error() {
      return undefined;
    },
    info() {
      return undefined;
    },
    warn(message) {
      warnings.push(message);
    },
  };
}

async function postJson(baseUrl: string, pathname: string, body: unknown, projectDir: string): Promise<unknown> {
  const url = new URL(pathname, baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  const serverState = JSON.parse(await readFile(path.join(projectDir, '.live-npm/server.json'), 'utf8')) as { token: string };
  return await new Promise((resolve, reject) => {
    const request = http.request({
      headers: {
        'content-length': String(payload.byteLength),
        'content-type': 'application/json',
        'x-live-npm-token': serverState.token,
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

async function listenOnRandomPort(server: http.Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (typeof address !== 'object' || !address) {
        reject(new Error('Could not read occupied server port.'));
        return;
      }
      resolve(address.port);
    });
  });
}
