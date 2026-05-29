import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { integrateProject } from '../src/integrate.js';

const require = createRequire(import.meta.url);

describe('integrateProject', () => {
  it('writes live-npm project files and a root pnpmfile shim when none exists', async () => {
    const root = await makeTempDir();
    await writePackageJson(root);

    const result = await integrateProject({
      projectDir: root,
    });

    expect(result.createdRootPnpmfile).toBe(true);
    expect(result.configCreated).toBe(true);
    expect(result.rootPnpmfileAction).toBe('created');
    const hooksText = await readFile(path.join(root, '.live-npm/pnpm-hooks.cjs'), 'utf8');
    expect(hooksText).toContain('custom:live-npm');
    expect(hooksText).toContain('server.json');
    expect(hooksText).not.toContain('8456');
    await expect(readFile(path.join(root, '.live-npm/pnpmfile.cjs'), 'utf8')).resolves.toContain('module.exports = function useLiveNPM');
    await expect(readVersionJson(root)).resolves.toMatchObject({
      integrationVersion: 2,
      liveNpmVersion: '0.0.0',
      pnpmfileMode: 'cjs-marked-block',
      schemaVersion: 1,
    });
    await expect(readFile(path.join(root, '.live-npm/.gitignore'), 'utf8')).resolves.toContain('server.json');
    await expect(readFile(path.join(root, '.live-npm/.gitignore'), 'utf8')).resolves.toContain('state.json');
    await expect(readFile(path.join(root, '.live-npm/config.yaml'), 'utf8')).resolves.toContain('packages: []');
    const rootPnpmfile = await readFile(path.join(root, '.pnpmfile.cjs'), 'utf8');
    expect(rootPnpmfile).toContain('// <live-npm>');
    expect(rootPnpmfile).toContain('require(\'./.live-npm/pnpmfile.cjs\')');
    expect(rootPnpmfile).toContain('module.exports = useLiveNPM(module.exports)');
  });

  it('injects live-npm into an existing root cjs pnpmfile', async () => {
    const root = await makeTempDir();
    await writePackageJson(root);
    await writeFile(path.join(root, '.pnpmfile.cjs'), [
      'module.exports = {',
      '  hooks: {',
      '    readPackage(manifest) {',
      '      return manifest;',
      '    },',
      '    importPackage() {',
      '      return \'existing\';',
      '    },',
      '  },',
      '  resolvers: [{ canResolve() { return false; } }],',
      '  fetchers: [],',
      '};',
      '',
    ].join('\n'));

    const result = await integrateProject({
      projectDir: root,
    });

    expect(result.createdRootPnpmfile).toBe(false);
    expect(result.rootPnpmfileAction).toBe('updated');
    const rootPnpmfile = await readFile(path.join(root, '.pnpmfile.cjs'), 'utf8');
    expect(rootPnpmfile).toContain('readPackage(manifest)');
    expect(rootPnpmfile).toContain('// <live-npm>');
    expect(rootPnpmfile).toContain('require(\'./.live-npm/pnpmfile.cjs\')');
    expect(rootPnpmfile).toContain('module.exports = useLiveNPM(module.exports)');

    const merged = require(path.join(root, '.pnpmfile.cjs')) as {
      fetchers: unknown[];
      hooks: {
        importPackage: unknown;
        readPackage: unknown;
      };
      resolvers: unknown[];
    };
    expect(typeof merged.hooks.readPackage).toBe('function');
    expect(typeof merged.hooks.importPackage).toBe('function');
    expect(merged.resolvers).toHaveLength(2);
    expect(merged.fetchers).toHaveLength(1);
  });

  it('updates the marked root cjs pnpmfile block without duplicating it', async () => {
    const root = await makeTempDir();
    await writePackageJson(root);

    const firstResult = await integrateProject({
      projectDir: root,
    });
    const secondResult = await integrateProject({
      projectDir: root,
    });
    const rootPnpmfile = await readFile(path.join(root, '.pnpmfile.cjs'), 'utf8');

    expect(firstResult.rootPnpmfileAction).toBe('created');
    expect(secondResult.rootPnpmfileAction).toBe('unchanged');
    expect(countOccurrences(rootPnpmfile, '// <live-npm>')).toBe(1);
    expect(countOccurrences(rootPnpmfile, '// </live-npm>')).toBe(1);
  });

  it('keeps an existing config file', async () => {
    const root = await makeTempDir();
    await writePackageJson(root);
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), 'packages:\n  - source: ../source\n');

    const result = await integrateProject({
      projectDir: root,
    });

    expect(result.configCreated).toBe(false);
    await expect(readFile(path.join(root, '.live-npm/config.yaml'), 'utf8')).resolves.toBe('packages:\n  - source: ../source\n');
  });

  it('requires pnpm 11 or newer because live hooks depend on the new resolver API', async () => {
    const root = await makeTempDir();
    await writePackageJson(root, 'pnpm@10.33.0');

    await expect(integrateProject({
      projectDir: root,
    })).rejects.toThrow('pnpm@11 or newer');
  });

  it('does not support root mjs pnpmfile yet', async () => {
    const root = await makeTempDir();
    await writePackageJson(root);
    await writeFile(path.join(root, '.pnpmfile.mjs'), 'export default {};\n');

    await expect(integrateProject({
      projectDir: root,
    })).rejects.toThrow('does not support .pnpmfile.mjs yet');
  });
});

async function writePackageJson(root: string, packageManager = 'pnpm@11.4.0'): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'consumer',
    packageManager,
  }, null, 2));
}

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'live-npm-'));
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

async function readVersionJson(root: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, '.live-npm/version.json'), 'utf8')) as unknown;
}
