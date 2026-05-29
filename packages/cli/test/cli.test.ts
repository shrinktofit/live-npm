import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/index.js';

describe('runCli', () => {
  it('uses .live-npm/config.yaml from process.cwd when config is omitted', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(path.join(source, 'lib'), { recursive: true });
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'sample-package',
      version: '0.0.0',
      files: ['lib'],
    }, null, 2));
    await writeFile(path.join(source, 'lib/index.js'), 'export const value = 1;\n');
    await mkdir(path.join(root, '.live-npm'), { recursive: true });
    await writeFile(path.join(root, '.live-npm/config.yaml'), [
      'packages:',
      '  - source: ../source',
      '',
    ].join('\n'));

    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      process.chdir(root);
      await runCli(['once', './target']);
    } finally {
      process.chdir(previousCwd);
      logSpy.mockRestore();
    }

    await expect(readFile(path.join(target, 'sample-package/lib/index.js'), 'utf8')).resolves.toContain('value = 1');
  });
});

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'live-npm-'));
}
