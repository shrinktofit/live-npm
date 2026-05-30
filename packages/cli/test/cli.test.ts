import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/index.js';

describe('runCli', () => {
  it('rejects removed direct target commands', async () => {
    await expect(runCli(['once', './node_modules'])).rejects.toThrow('Unknown argument');
    await expect(runCli(['watch', './node_modules'])).rejects.toThrow('Unknown argument');
  });

  it('prints project status from the running live-npm server', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'live-npm-cli-'));
    const server = http.createServer((request, response) => {
      if (request.url !== '/status' || request.headers['x-live-npm-token'] !== 'test-token') {
        response.statusCode = 401;
        response.end('unauthorized');
        return;
      }
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({
        packages: [
          {
            name: 'package-a',
            source: path.join(root, 'source'),
            targets: [
              path.join(root, 'node_modules/package-a'),
            ],
            watchGroupKey: `package:${path.join(root, 'source')}`,
          },
        ],
        pid: 123,
        projects: [root],
        watchGroups: [
          {
            key: `package:${path.join(root, 'source')}`,
            kind: 'package',
            packages: ['package-a'],
            root: path.join(root, 'source'),
            watchedDirs: 2,
            watchedEntries: 3,
            watchPaths: [
              path.join(root, 'source/package.json'),
            ],
          },
        ],
      }));
    });
    const port = await listenOnRandomPort(server);
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/server.json'), JSON.stringify({
      pid: 123,
      projectDir: root,
      startedAt: new Date().toISOString(),
      token: 'test-token',
      url: `http://127.0.0.1:${port}`,
      version: 1,
    }, null, 2));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await runCli(['status', '--project', root]);
      expect(info.mock.calls.join('\n')).toContain('live-npm server');
      expect(info.mock.calls.join('\n')).toContain('package-a');
      expect(info.mock.calls.join('\n')).toContain('watched dirs: 2');
    } finally {
      info.mockRestore();
      await closeServer(server);
    }
  });
});

async function listenOnRandomPort(server: http.Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (typeof address !== 'object' || !address) {
        reject(new Error('Could not read server port.'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
