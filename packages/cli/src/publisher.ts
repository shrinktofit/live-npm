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

export interface PublishFileChange {
  event: string;
  path: string;
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

export async function publishPackageChange(
  source: string,
  target: string,
  change: PublishFileChange,
  options: PublishOptions,
): Promise<PublishResult> {
  return await publishPackageChanges(source, target, [change], options);
}

export async function publishPackageChanges(
  source: string,
  target: string,
  changes: PublishFileChange[],
  options: PublishOptions,
): Promise<PublishResult> {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  assertSafeTarget(resolvedSource, resolvedTarget);

  const plan = await createPublishPlan(resolvedSource, resolvedTarget);
  const packageLabel = formatPackageTarget(plan.packageName, resolvedTarget);
  const relativeChanges = changes.flatMap((change) => {
    const relativeFile = toPackageRelativePath(resolvedSource, change.path);
    return relativeFile ? [{ event: change.event, relativeFile }] : [];
  });
  if (relativeChanges.length === 0) {
    return createEmptyPublishResult(plan);
  }

  if (options.dryRun) {
    const copied = relativeChanges.filter((change) => shouldCopyChangedPath(plan, change.relativeFile, change.event)).length;
    const deleted = relativeChanges.filter((change) => shouldDeleteChangedPath(change.event)).length;
    options.logger.info(`${chalk.yellow('[dry-run]')} ${packageLabel}: ${formatChangedSummary(copied, deleted)}`);
    return {
      copied,
      deleted,
      files: plan.files,
      packageName: plan.packageName,
      source: resolvedSource,
      target: resolvedTarget,
    };
  }

  await mkdir(resolvedTarget, { recursive: true });
  let copied = 0;
  let deleted = 0;
  for (const change of relativeChanges) {
    const result = await syncChangedPath(plan, change.relativeFile, change.event, options.manifestRewrite);
    copied += result.copied;
    deleted += result.deleted;
  }
  if (copied > 0 || deleted > 0) {
    options.logger.info(`${packageLabel}: ${formatChangedSummary(copied, deleted)}`);
  }

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

async function syncChangedPath(
  plan: PublishPlan,
  relativeFile: string,
  event: string,
  manifestRewrite?: ManifestRewriteConfig,
): Promise<{ copied: number; deleted: number }> {
  if (event === 'addDir') {
    return await syncChangedDirectory(plan, relativeFile, manifestRewrite);
  }

  const targetPath = path.join(plan.target, ...relativeFile.split('/'));
  if (shouldDeleteChangedPath(event)) {
    const deleted = await countTargetFiles(targetPath);
    await rm(targetPath, { force: true, recursive: true });
    await removeEmptyDirs(plan.target, plan.target);
    return { copied: 0, deleted };
  }

  if (!plan.files.includes(relativeFile)) {
    const deleted = await countTargetFiles(targetPath);
    await rm(targetPath, { force: true, recursive: true });
    await removeEmptyDirs(plan.target, plan.target);
    return { copied: 0, deleted };
  }

  const sourcePath = path.join(plan.source, ...relativeFile.split('/'));
  try {
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      return { copied: 0, deleted: 0 };
    }
  } catch {
    const deleted = await countTargetFiles(targetPath);
    await rm(targetPath, { force: true, recursive: true });
    await removeEmptyDirs(plan.target, plan.target);
    return { copied: 0, deleted };
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await rm(targetPath, { force: true, recursive: true });
  await copyPlannedFile(plan, relativeFile, manifestRewrite);
  return { copied: 1, deleted: 0 };
}

async function syncChangedDirectory(
  plan: PublishPlan,
  relativeDir: string,
  manifestRewrite?: ManifestRewriteConfig,
): Promise<{ copied: number; deleted: number }> {
  const directoryPrefix = relativeDir.endsWith('/') ? relativeDir : `${relativeDir}/`;
  const files = plan.files.filter((file) => file.startsWith(directoryPrefix));
  let copied = 0;
  for (const file of files) {
    await copyPlannedFile(plan, file, manifestRewrite);
    copied += 1;
  }
  return { copied, deleted: 0 };
}

async function copyPlannedFile(
  plan: PublishPlan,
  relativeFile: string,
  manifestRewrite?: ManifestRewriteConfig,
): Promise<void> {
  const sourcePath = path.join(plan.source, ...relativeFile.split('/'));
  const targetPath = path.join(plan.target, ...relativeFile.split('/'));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await rm(targetPath, { force: true, recursive: true });
  if (relativeFile === 'package.json' && manifestRewrite) {
    await writeFile(targetPath, `${JSON.stringify(rewritePublishManifest(plan.manifest, manifestRewrite), null, 2)}\n`);
  } else {
    await copyFile(sourcePath, targetPath);
  }
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

async function countTargetFiles(targetPath: string): Promise<number> {
  try {
    const targetStat = await stat(targetPath);
    if (targetStat.isFile()) {
      return 1;
    }
    if (targetStat.isDirectory()) {
      return (await listFiles(targetPath)).length;
    }
  } catch {
    return 0;
  }
  return 0;
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

function formatChangedSummary(copied: number, deleted: number): string {
  return `${chalk.green('updated')} ${formatCount(copied)} ${chalk.dim('files,')} ${formatDeleted(deleted)}`;
}

function shouldCopyChangedPath(plan: PublishPlan, relativeFile: string, event: string): boolean {
  return !shouldDeleteChangedPath(event) && plan.files.includes(relativeFile);
}

function shouldDeleteChangedPath(event: string): boolean {
  return event === 'unlink' || event === 'unlinkDir';
}

function createEmptyPublishResult(plan: PublishPlan): PublishResult {
  return {
    copied: 0,
    deleted: 0,
    files: plan.files,
    packageName: plan.packageName,
    source: plan.source,
    target: plan.target,
  };
}

function toPackageRelativePath(source: string, file: string): string | undefined {
  const relative = path.relative(source, path.resolve(file));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, '/');
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
