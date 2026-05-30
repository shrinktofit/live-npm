import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishPackage } from '../src/publisher.js';
import { resolveWorkspacePackageConfigs } from '../src/workspace.js';
import { silentLogger } from '../src/logger.js';

describe('resolveWorkspacePackageConfigs', () => {
  it('resolves pnpm workspace dependency closure and rewrites published manifests', async () => {
    const root = await makeTempDir();
    const target = path.join(root, 'published', 'node_modules');
    await writeWorkspace(root);

    const configs = await resolveWorkspacePackageConfigs({
      includes: ['package-a'],
      path: root,
    });

    expect(configs.map((config) => path.basename(config.source)).sort()).toEqual(['a', 'b', 'c', 'peer']);
    expect([...new Set(configs.map((config) => config.watchGroup.key))]).toEqual([`workspace:${root}`]);
    expect(configs.map((config) => packageTargetPath(target, config.name)).sort()).toEqual([
      path.join(target, 'package-a'),
      path.join(target, 'package-b'),
      path.join(target, 'package-c'),
      path.join(target, 'package-peer'),
    ]);

    for (const config of configs) {
      await publishPackage(config.source, packageTargetPath(target, config.name), {
        dryRun: false,
        logger: silentLogger,
        ...(config.manifestRewrite ? { manifestRewrite: config.manifestRewrite } : {}),
      });
    }

    await expect(readPackageJson(path.join(target, 'package-a'))).resolves.toMatchObject({
      dependencies: {
        'package-b': 'live:package-b',
        'package-c': 'live:package-c',
        'react': '^18.3.0',
      },
      peerDependencies: {
        'package-peer': '^1.5.0',
      },
    });
  });

  it('reports unsupported workspace package managers', async () => {
    const root = await makeTempDir();
    await writeFile(path.join(root, 'package.json'), JSON.stringify({
      packageManager: 'yarn@4.0.0',
    }, null, 2));

    await expect(resolveWorkspacePackageConfigs({
      includes: ['package-a'],
      path: root,
    })).rejects.toThrow('supports pnpm only');
  });
});

function packageTargetPath(targetRoot: string, packageName: string): string {
  return path.join(targetRoot, ...packageName.split('/'));
}

async function writeWorkspace(root: string): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    packageManager: 'pnpm@10.0.0',
  }, null, 2));
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - packages/*',
    'catalog:',
    '  react: ^18.3.0',
    '',
  ].join('\n'));

  await writePackage(path.join(root, 'packages/a'), {
    name: 'package-a',
    version: '1.1.0',
    dependencies: {
      'package-b': 'workspace:*',
      'package-c': 'workspace:^',
      'react': 'catalog:',
    },
    devDependencies: {
      'package-dev': 'workspace:*',
    },
    peerDependencies: {
      'package-peer': 'workspace:^',
    },
    files: ['lib'],
  });
  await writePackage(path.join(root, 'packages/b'), {
    name: 'package-b',
    version: '1.2.0',
    dependencies: {
      'package-c': 'workspace:*',
    },
    files: ['lib'],
  });
  await writePackage(path.join(root, 'packages/c'), {
    name: 'package-c',
    version: '1.3.0',
    files: ['lib'],
  });
  await writePackage(path.join(root, 'packages/unused'), {
    name: 'package-unused',
    files: ['lib'],
  });
  await writePackage(path.join(root, 'packages/dev'), {
    name: 'package-dev',
    version: '1.4.0',
    files: ['lib'],
  });
  await writePackage(path.join(root, 'packages/peer'), {
    name: 'package-peer',
    version: '1.5.0',
    files: ['lib'],
  });
}

async function writePackage(packagePath: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(packagePath, 'lib'), { recursive: true });
  await writeFile(path.join(packagePath, 'package.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(packagePath, 'lib/index.js'), 'export {};\n');
}

async function readPackageJson(packagePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8')) as unknown;
}

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'live-npm-'));
}
