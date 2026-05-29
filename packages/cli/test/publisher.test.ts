import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishPackage } from '../src/publisher.js';
import { silentLogger } from '../src/logger.js';

describe('publishPackage', () => {
  it('copies npm packlist files and removes stale target files', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(path.join(source, 'lib'), { recursive: true });
    await mkdir(path.join(source, 'src'), { recursive: true });
    await mkdir(path.join(target, 'lib'), { recursive: true });

    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'sample-package',
      version: '0.0.0',
      files: [
        'lib',
      ],
    }, null, 2));
    await writeFile(path.join(source, 'lib/index.js'), 'export const value = 1;\n');
    await writeFile(path.join(source, 'src/private.ts'), 'export const privateValue = 1;\n');
    await writeFile(path.join(target, 'lib/stale.js'), 'stale\n');

    const result = await publishPackage(source, target, {
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.packageName).toBe('sample-package');
    await expect(readFile(path.join(target, 'package.json'), 'utf8')).resolves.toContain('"sample-package"');
    await expect(readFile(path.join(target, 'lib/index.js'), 'utf8')).resolves.toContain('value = 1');
    await expectExists(path.join(target, 'src/private.ts'), false);
    await expectExists(path.join(target, 'lib/stale.js'), false);
  });

  it('uses npm default packlist when package.json#files is omitted', async () => {
    const root = await makeTempDir();
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    await mkdir(path.join(source, 'src'), { recursive: true });
    await writeFile(path.join(source, 'package.json'), JSON.stringify({
      name: 'sample-package',
      version: '0.0.0',
    }, null, 2));
    await writeFile(path.join(source, 'src/index.ts'), 'export const value = 1;\n');

    const result = await publishPackage(source, target, {
      dryRun: false,
      logger: silentLogger,
    });

    expect(result.files).toContain('package.json');
    expect(result.files).toContain('src/index.ts');
    await expect(readFile(path.join(target, 'src/index.ts'), 'utf8')).resolves.toContain('value = 1');
  });
});

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'live-npm-'));
}

async function expectExists(file: string, exists: boolean): Promise<void> {
  try {
    await stat(file);
    expect(exists).toBe(true);
  } catch {
    expect(exists).toBe(false);
  }
}
