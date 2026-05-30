import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { createPublishPlan, type PublishPlan } from './package-plan.js';
import { rewritePublishManifest } from './manifest-rewrite.js';
import type { ManifestRewriteConfig } from './config.js';
import type { Logger } from './logger.js';

export interface PublishOptions {
  dryRun: boolean;
  logger: Logger;
  manifestRewrite?: ManifestRewriteConfig;
}

export interface PublishResult {
  copied: number;
  deleted: number;
  files: string[];
  packageName: string;
  source: string;
  target: string;
}

export async function publishPackage(source: string, target: string, options: PublishOptions): Promise<PublishResult> {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  assertSafeTarget(resolvedSource, resolvedTarget);

  const plan = await createPublishPlan(resolvedSource, resolvedTarget);
  const packageLabel = formatPackageTarget(plan.packageName, resolvedTarget);

  if (options.dryRun) {
    options.logger.info(`${chalk.yellow('[dry-run]')} ${packageLabel}: ${formatCount(plan.files.length)} ${chalk.dim('files')}`);
    return {
      copied: plan.files.length,
      deleted: 0,
      files: plan.files,
      packageName: plan.packageName,
      source: resolvedSource,
      target: resolvedTarget,
    };
  }

  await mkdir(resolvedTarget, { recursive: true });
  const deleted = await deleteExtraneousFiles(plan, options.logger);
  const copied = await copyPublishFiles(plan, options.manifestRewrite);
  options.logger.info(`${packageLabel}: ${chalk.green('copied')} ${formatCount(copied)} ${chalk.dim('files,')} ${formatDeleted(deleted)}`);

  return {
    copied,
    deleted,
    files: plan.files,
    packageName: plan.packageName,
    source: resolvedSource,
    target: resolvedTarget,
  };
}

async function copyPublishFiles(plan: PublishPlan, manifestRewrite?: ManifestRewriteConfig): Promise<number> {
  let copied = 0;
  for (const file of plan.files) {
    const sourcePath = path.join(plan.source, ...file.split('/'));
    const targetPath = path.join(plan.target, ...file.split('/'));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await rm(targetPath, { force: true, recursive: true });
    if (file === 'package.json' && manifestRewrite) {
      await writeFile(targetPath, `${JSON.stringify(rewritePublishManifest(plan.manifest, manifestRewrite), null, 2)}\n`);
    } else {
      await copyFile(sourcePath, targetPath);
    }
    copied += 1;
  }
  return copied;
}

async function deleteExtraneousFiles(plan: PublishPlan, logger: Logger): Promise<number> {
  const keep = new Set(plan.files);
  const targetFiles = await listFiles(plan.target);
  let deleted = 0;

  for (const file of targetFiles) {
    if (keep.has(file)) {
      continue;
    }
    const targetPath = path.join(plan.target, ...file.split('/'));
    logger.debug(`delete stale file ${targetPath}`);
    await rm(targetPath, { force: true });
    deleted += 1;
  }

  await removeEmptyDirs(plan.target, plan.target);
  return deleted;
}

async function listFiles(root: string): Promise<string[]> {
  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const files: string[] = [];
  await collectFiles(root, root, files);
  return files.sort();
}

async function collectFiles(root: string, dir: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (shouldSkipTargetEntry(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    files.push(toRelativeFile(root, fullPath));
  }
}

async function removeEmptyDirs(root: string, dir: string): Promise<boolean> {
  let entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipTargetEntry(entry.name)) {
      continue;
    }
    const childDir = path.join(dir, entry.name);
    if (await removeEmptyDirs(root, childDir)) {
      await rm(childDir, { force: true, recursive: true });
    }
  }

  entries = await readdir(dir, { withFileTypes: true });
  return dir !== root && entries.length === 0;
}

function shouldSkipTargetEntry(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === '.pnpm';
}

function formatCount(count: number): string {
  return chalk.cyan(String(count));
}

function formatDeleted(count: number): string {
  const label = count === 0 ? chalk.dim('deleted') : chalk.yellow('deleted');
  return `${label} ${formatCount(count)} ${chalk.dim('stale files')}`;
}

function formatPackageTarget(packageName: string, target: string): string {
  return `${chalk.bold(packageName)} ${chalk.dim('->')} ${chalk.dim(target)}`;
}

function toRelativeFile(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, '/');
}

function assertSafeTarget(source: string, target: string): void {
  const parsedTarget = path.parse(target);
  if (target === parsedTarget.root) {
    throw new Error(`Refusing to publish into drive root ${target}.`);
  }
  if (target === source) {
    throw new Error(`Refusing to publish ${source} into itself.`);
  }
  if (isInside(target, source)) {
    throw new Error(`Refusing to publish ${source} into its own parent ${target}.`);
  }
  if (isInside(source, target)) {
    throw new Error(`Refusing to publish ${source} into its own child ${target}.`);
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
