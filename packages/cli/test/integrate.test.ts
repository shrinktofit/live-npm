import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { integrateProject } from '../src/integrate.js';

describe('integrateProject', () => {
  it('writes live-npm project files and a root pnpmfile shim when none exists', async () => {
    const root = await makeTempDir();
    await writePackageJson(root);

    const result = await integrateProject({
      host: '127.0.0.1',
      port: 8456,
      projectDir: root,
    });

    expect(result.createdRootPnpmfile).toBe(true);
    await expect(readFile(path.join(root, '.live-npm/pnpm-hooks.cjs'), 'utf8')).resolves.toContain('custom:live-npm');
    await expect(readFile(path.join(root, '.live-npm/pnpmfile.cjs'), 'utf8')).resolves.toContain('importPackage');
    await expect(readFile(path.join(root, '.live-npm/config.yaml'), 'utf8')).resolves.toContain('packages: []');
    await expect(readFile(path.join(root, '.pnpmfile.cjs'), 'utf8')).resolves.toContain('.live-npm/pnpmfile.cjs');
  });

  it('does not overwrite an existing root pnpmfile', async () => {
    const root = await makeTempDir();
    await writePackageJson(root);
    await writeFile(path.join(root, '.pnpmfile.cjs'), 'module.exports = { hooks: {} };\n');

    const result = await integrateProject({
      host: '127.0.0.1',
      port: 8456,
      projectDir: root,
    });

    expect(result.createdRootPnpmfile).toBe(false);
    await expect(readFile(path.join(root, '.pnpmfile.cjs'), 'utf8')).resolves.toBe('module.exports = { hooks: {} };\n');
    await expect(readFile(path.join(root, '.live-npm/pnpmfile-snippet.cjs'), 'utf8')).resolves.toContain('.live-npm/pnpm-hooks.cjs');
  });
});

async function writePackageJson(root: string): Promise<void> {
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'consumer',
    packageManager: 'pnpm@11.4.0',
  }, null, 2));
}

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'live-npm-'));
}
