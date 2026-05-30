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

  it('keeps packages with globbed files entries live when nested build output is added', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'node_modules/.pnpm/live/node_modules/sample-package');
    await writeSourcePackage(source, 'export const value = 1;\n', ['lib/**', '!lib/**/*.map']);
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

    await mkdir(path.join(source, 'lib/font'), { recursive: true });
    await writeFile(path.join(source, 'lib/font/index.js'), 'export const font = 1;\n');

    await waitFor(async () => {
      await expect(readFile(path.join(target, 'lib/font/index.js'), 'utf8')).resolves.toContain('font = 1');
    });
  });

  it('uses shallow package roots only to discover future publish directories', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'node_modules/.pnpm/live/node_modules/sample-package');
    await writeSourcePackage(source, 'export const value = 1;\n', ['lib', 'public/**/*']);
    await mkdir(path.join(source, 'src'), { recursive: true });
    await writeFile(path.join(source, 'src/private.ts'), 'export const privateValue = 1;\n');
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

    const status = await readStatus(root, server.url);
    expect(status.watchGroups[0]?.shallowWatchPaths).toContainEqual({
      root: source,
      target: path.join(source, 'public'),
    });

    await writeFile(path.join(target, 'lib/index.js'), 'stale target\n');
    await writeFile(path.join(source, 'src/private.ts'), 'export const privateValue = 2;\n');
    await sleep(750);
    await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('stale target');

    await mkdir(path.join(source, 'public'), { recursive: true });
    await writeFile(path.join(source, 'public/index.css'), 'body { color: red; }\n');
    await waitFor(async () => {
      await expect(readFile(path.join(target, 'public/index.css'), 'utf8')).resolves.toContain('color: red');
      await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 1');
    });
  });

  it('rebuilds package watchers when package.json publish files change', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'node_modules/.pnpm/live/node_modules/sample-package');
    await writeSourcePackage(source, 'export const value = 1;\n', ['lib']);
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

    await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 1');

    await mkdir(path.join(source, 'dist'), { recursive: true });
    await writeFile(path.join(source, 'dist/index.js'), 'export const value = 2;\n');
    await writeSourceManifest(source, ['dist/**']);

    await waitFor(async () => {
      await expect(readFile(path.join(target, 'dist/index.js'), 'utf8')).resolves.toContain('value = 2');
      await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).rejects.toThrow();
    });
  });

  it('refreshes ignored rules when package.json files changes without changing watch roots', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'node_modules/.pnpm/live/node_modules/sample-package');
    await writeSourcePackage(source, 'export const value = 1;\n', ['lib/**']);
    await writeFile(path.join(source, 'lib/index.js.map'), '{}\n');
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

    await expect(readFile(path.join(target, 'lib/index.js.map'), 'utf8')).resolves.toContain('{}');
    await writeSourceManifest(source, ['lib/**', '!lib/**/*.map']);
    await waitFor(async () => {
      await expect(readFile(path.join(target, 'lib/index.js.map'), 'utf8')).rejects.toThrow();
    });

    await writeFile(path.join(target, 'lib/index.js'), 'stale target\n');
    await writeFile(path.join(source, 'lib/index.js.map'), '{"updated":true}\n');
    await sleep(750);
    await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('stale target');
  });

  it('shares one watcher for packages from the same workspace and routes package events', async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, 'workspace');
    const targetA = path.join(root, 'node_modules/.pnpm/live-a/node_modules/package-a');
    const targetB = path.join(root, 'node_modules/.pnpm/live-b/node_modules/package-b');
    await writeWorkspacePackage(workspace, 'packages/a', {
      dependencies: {
        'package-b': 'workspace:*',
      },
      name: 'package-a',
      version: '1.0.0',
    }, 'export const value = "a1";\n');
    await writeWorkspacePackage(workspace, 'packages/b', {
      name: 'package-b',
      version: '1.0.0',
    }, 'export const value = "b1";\n');
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10.0.0',
      private: true,
    }, null, 2));
    await writeFile(path.join(workspace, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - packages/*',
      '',
    ].join('\n'));
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), [
      'debounceMs: 25',
      'workspaces:',
      '  - path: ../workspace',
      '    includes:',
      '      - package-a',
      '',
    ].join('\n'));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    await postJson(server.url, '/register-import', {
      destinationDir: targetA,
      packageName: 'package-a',
      projectDir: root,
    }, root);
    await postJson(server.url, '/register-import', {
      destinationDir: targetB,
      packageName: 'package-b',
      projectDir: root,
    }, root);

    const status = await readStatus(root, server.url);
    expect(status.watchGroups).toHaveLength(1);
    expect(status.watchGroups[0]).toMatchObject({
      kind: 'workspace',
      packages: ['package-a', 'package-b'],
      root: workspace,
    });
    expect(status.packages.map((statusPackage) => statusPackage.name).sort()).toEqual(['package-a', 'package-b']);

    await writeFile(path.join(workspace, 'packages/a/lib/index.js'), 'export const value = "a2";\n');
    await waitFor(async () => {
      await expect(readFile(path.join(targetA, 'lib/index.js'), 'utf8')).resolves.toContain('"a2"');
    });
    await expect(readFile(path.join(targetB, 'lib/index.js'), 'utf8')).resolves.toContain('"b1"');
  });

  it('publishes every package in a workspace watch group when workspace metadata changes', async () => {
    const root = await makeTempDir();
    const workspace = path.join(root, 'workspace');
    const targetA = path.join(root, 'node_modules/.pnpm/live-a/node_modules/package-a');
    const targetB = path.join(root, 'node_modules/.pnpm/live-b/node_modules/package-b');
    await writeWorkspacePackage(workspace, 'packages/a', {
      dependencies: {
        'package-b': 'workspace:*',
      },
      name: 'package-a',
      version: '1.0.0',
    }, 'export const value = "a1";\n');
    await writeWorkspacePackage(workspace, 'packages/b', {
      name: 'package-b',
      version: '1.0.0',
    }, 'export const value = "b1";\n');
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10.0.0',
      private: true,
    }, null, 2));
    await writeFile(path.join(workspace, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - packages/*',
      '',
    ].join('\n'));
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), [
      'debounceMs: 25',
      'workspaces:',
      '  - path: ../workspace',
      '    includes:',
      '      - package-a',
      '',
    ].join('\n'));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    await postJson(server.url, '/register-import', {
      destinationDir: targetA,
      packageName: 'package-a',
      projectDir: root,
    }, root);
    await postJson(server.url, '/register-import', {
      destinationDir: targetB,
      packageName: 'package-b',
      projectDir: root,
    }, root);

    await writeFile(path.join(targetA, 'lib/index.js'), 'stale package-a target\n');
    await writeFile(path.join(targetB, 'lib/index.js'), 'stale package-b target\n');
    await writeFile(path.join(workspace, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - packages/*',
      'catalog:',
      '  react: ^18.3.0',
      '',
    ].join('\n'));

    await waitFor(async () => {
      await expect(readFile(path.join(targetA, 'lib/index.js'), 'utf8')).resolves.toContain('"a1"');
      await expect(readFile(path.join(targetB, 'lib/index.js'), 'utf8')).resolves.toContain('"b1"');
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
    expect(warnings.join('\n')).toContain('version.json');
    expect(warnings.join('\n')).toContain('live-npm integrate');
    expect(warnings.join('\n')).toContain('Run pnpm install once');
  });

  it('warns when the project integration version is outdated', async () => {
    const root = await makeTempDir();
    const warnings: string[] = [];
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');
    await writeFile(path.join(root, '.live-npm/state.json'), JSON.stringify({
      imports: [],
      version: 1,
    }, null, 2));
    await writeFile(path.join(root, '.live-npm/version.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      integrationVersion: 1,
      liveNpmVersion: '0.0.0',
      pnpmfileMode: 'legacy-snippet',
      schemaVersion: 1,
    }, null, 2));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: createTestLogger(warnings),
      port: 0,
      projectDirs: [root],
    });

    expect(warnings.join('\n')).toContain('integration version 1');
    expect(warnings.join('\n')).toContain('Current integration version is 2');
    expect(warnings.join('\n')).toContain('live-npm integrate');
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

  it('removes its server endpoint state when it closes', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    await expect(readFile(path.join(root, '.live-npm/server.json'), 'utf8')).resolves.toContain(server.url);
    await server.close();
    server = undefined;
    await expect(readFile(path.join(root, '.live-npm/server.json'), 'utf8')).rejects.toThrow();
  });

  it('does not remove a newer server endpoint state when an older server closes', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    const replacementState = {
      ...await readServerState(root),
      token: 'replacement-token',
      url: 'http://127.0.0.1:65535',
    };
    await writeFile(path.join(root, '.live-npm/server.json'), `${JSON.stringify(replacementState, null, 2)}\n`);
    await server.close();
    server = undefined;

    await expect(readServerState(root)).resolves.toMatchObject({
      token: 'replacement-token',
      url: 'http://127.0.0.1:65535',
    });
  });

  it('requires the per-project token for health and package requests', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    await expect(requestJson(server.url, '/health')).resolves.toMatchObject({
      statusCode: 401,
    });
    await expect(requestJson(server.url, '/health', { token: 'wrong-token' })).resolves.toMatchObject({
      statusCode: 401,
    });
    await expect(requestJson(server.url, '/status')).resolves.toMatchObject({
      statusCode: 401,
    });

    const serverState = await readServerState(root);
    await expect(requestJson(server.url, '/health', { token: serverState.token })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(requestJson(server.url, '/status', { token: serverState.token })).resolves.toMatchObject({
      statusCode: 200,
    });
    await expect(requestJson(server.url, '/resolve', {
      body: {
        packageName: 'sample-package',
        projectDir: root,
      },
      method: 'POST',
    })).resolves.toMatchObject({
      statusCode: 401,
    });
  });

  it('returns a clear error when a live package is not configured', async () => {
    const root = await makeTempDir();
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    const serverState = await readServerState(root);
    const response = await requestJson(server.url, '/resolve', {
      body: {
        packageName: 'sample-package',
        projectDir: root,
      },
      method: 'POST',
      token: serverState.token,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('live-npm cannot resolve live:sample-package');
    expect(response.body).toContain('has no source packages or workspaces configured');
    expect(response.body).not.toContain('at loadConfig');
  });

  it('reuses the previous project port when it is available', async () => {
    const root = await makeTempDir();
    const previousPort = await reserveFreePort();
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages: []\nworkspaces: []\n');
    await writeFile(path.join(root, '.live-npm/server.json'), JSON.stringify({
      pid: 1,
      projectDir: root,
      startedAt: new Date().toISOString(),
      token: 'stale-token',
      url: `http://127.0.0.1:${previousPort}`,
      version: 1,
    }, null, 2));

    server = await startLiveNpmServer({
      host: '127.0.0.1',
      logger: silentLogger,
      port: 0,
      projectDirs: [root],
    });

    expect(server.url).toBe(`http://127.0.0.1:${previousPort}`);
    const serverState = await readServerState(root);
    expect(serverState.url).toBe(server.url);
    expect(serverState.token).not.toBe('stale-token');
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
      const serverState = await readServerState(root);
      expect(serverState.url).toBe(server.url);
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
  const serverState = await readServerState(projectDir);
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

interface JsonRequestOptions {
  body?: unknown;
  method?: string;
  token?: string;
}

interface JsonResponse {
  body: string;
  statusCode: number;
}

async function requestJson(baseUrl: string, pathname: string, options: JsonRequestOptions = {}): Promise<JsonResponse> {
  const url = new URL(pathname, baseUrl);
  const payload = options.body === undefined
    ? undefined
    : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  if (payload) {
    headers['content-length'] = String(payload.byteLength);
    headers['content-type'] = 'application/json';
  }
  if (options.token) {
    headers['x-live-npm-token'] = options.token;
  }

  return await new Promise((resolve, reject) => {
    const request = http.request({
      headers,
      host: url.hostname,
      method: options.method ?? 'GET',
      path: url.pathname,
      port: url.port,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({
          body: Buffer.concat(chunks).toString('utf8'),
          statusCode: response.statusCode ?? 0,
        });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

interface ServerState {
  pid: number;
  projectDir: string;
  startedAt: string;
  token: string;
  url: string;
  version: 1;
}

interface StatusResponse {
  packages: {
    name: string;
  }[];
  watchGroups: {
    kind: string;
    packages: string[];
    root: string;
    shallowWatchPaths?: {
      root: string;
      target: string;
    }[];
  }[];
}

async function readServerState(root: string): Promise<ServerState> {
  return JSON.parse(await readFile(path.join(root, '.live-npm/server.json'), 'utf8')) as ServerState;
}

async function readStatus(root: string, baseUrl: string): Promise<StatusResponse> {
  const serverState = await readServerState(root);
  const response = await requestJson(baseUrl, '/status', { token: serverState.token });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as StatusResponse;
}

async function writeSourcePackage(source: string, contents: string, files: string[] = ['lib']): Promise<void> {
  await mkdir(path.join(source, 'lib'), { recursive: true });
  await writeSourceManifest(source, files);
  await writeFile(path.join(source, 'lib/index.js'), contents);
}

async function writeSourceManifest(source: string, files: string[]): Promise<void> {
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: 'sample-package',
    version: '0.0.0',
    files,
  }, null, 2));
}

async function writeWorkspacePackage(
  workspace: string,
  relativePackagePath: string,
  manifest: Record<string, unknown>,
  contents: string,
): Promise<void> {
  const packagePath = path.join(workspace, relativePackagePath);
  await mkdir(path.join(packagePath, 'lib'), { recursive: true });
  await writeFile(path.join(packagePath, 'package.json'), JSON.stringify({
    files: ['lib'],
    ...manifest,
  }, null, 2));
  await writeFile(path.join(packagePath, 'lib/index.js'), contents);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

async function reserveFreePort(): Promise<number> {
  const server = http.createServer();
  const port = await listenOnRandomPort(server);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}
