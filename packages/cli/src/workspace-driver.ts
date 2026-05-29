import type { CatalogRewriteConfig } from './config.js';
import type { PackageManifest } from './package-plan.js';

export interface WorkspacePackage {
  manifest: PackageManifest;
  name: string;
  path: string;
  version?: string;
}

export interface WorkspaceDriver {
  name: string;
  listPackages(workspacePath: string): Promise<WorkspacePackage[]>;
  readCatalogs(workspacePath: string): Promise<CatalogRewriteConfig>;
  readMetadataPaths(workspacePath: string): Promise<string[]>;
}
