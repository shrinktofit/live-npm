import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const currentIntegrationVersion = 2;
export const integrationPnpmfileMode = 'cjs-marked-block';
export const integrationVersionFileName = 'version.json';

export interface IntegrationVersionFile {
  generatedAt: string;
  integrationVersion: number;
  liveNpmVersion: string;
  pnpmfileMode: string;
  schemaVersion: 1;
}

export async function createIntegrationVersionFile(): Promise<IntegrationVersionFile> {
  return {
    generatedAt: new Date().toISOString(),
    integrationVersion: currentIntegrationVersion,
    liveNpmVersion: await readLiveNpmVersion(),
    pnpmfileMode: integrationPnpmfileMode,
    schemaVersion: 1,
  };
}

async function readLiveNpmVersion(): Promise<string> {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version?: unknown };
  return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
}
