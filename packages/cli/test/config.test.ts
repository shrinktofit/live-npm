import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads yaml packages and resolves relative paths from the config directory', async () => {
    const root = await makeTempDir();
    const configPath = path.join(root, 'live-npm.yaml');
    await writeFile(configPath, [
      'debounceMs: 25',
      'packages:',
      '  - source: ./packages/a',
      '',
    ].join('\n'));

    await mkdir(path.join(root, 'packages'), { recursive: true });
    const config = await loadConfig(configPath);

    expect(config).toEqual({
      debounceMs: 25,
      packages: [
        {
          source: path.join(root, 'packages/a'),
        },
      ],
      workspaces: [],
    });
  });

  it('loads yaml workspaces and resolves relative paths from the config directory', async () => {
    const root = await makeTempDir();
    const configPath = path.join(root, 'live-npm.yaml');
    await writeFile(configPath, [
      'workspaces:',
      '  - path: ./workspace',
      '    includes:',
      '      - package-a',
      '      - package-b',
      '',
    ].join('\n'));

    const config = await loadConfig(configPath);

    expect(config).toEqual({
      debounceMs: 200,
      packages: [],
      workspaces: [
        {
          includes: ['package-a', 'package-b'],
          path: path.join(root, 'workspace'),
        },
      ],
    });
  });
});

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'live-npm-'));
}
