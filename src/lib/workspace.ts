import { getPackages } from '@manypkg/get-packages';
import { join, relative } from 'node:path';

import type { WorkspacePackage } from '../types';

export type WorkspaceDiscovery = {
  root: string;
  tool: string;
  packages: WorkspacePackage[];
};

export type WorkspaceTool = 'pnpm' | 'yarn' | 'npm' | 'bolt' | 'lerna' | 'rush' | 'root';

export async function discoverWorkspace(cwd: string): Promise<{
  root: string;
  tool: WorkspaceTool;
  packages: WorkspacePackage[];
}> {
  const result = await getPackages(cwd);
  return {
    root: result.rootDir,
    tool: result.tool.type as WorkspaceTool,
    packages: result.packages.map(pkg => ({
      name: pkg.packageJson.name,
      dir: pkg.dir,
      packageJson: pkg.packageJson as Record<string, any>,
      publishable: !pkg.packageJson.private,
    })),
  };
}

export function findPackage(packages: WorkspacePackage[], name: string): WorkspacePackage | undefined {
  return packages.find(p => p.name === name);
}

export async function loadCatalogs(workspaceRoot: string): Promise<Record<string, Record<string, string>>> {
  const file = Bun.file(join(workspaceRoot, 'pnpm-workspace.yaml'));
  if (!(await file.exists())) {
    return {};
  }

  const { parse } = await import('yaml');
  const content = parse(await file.text());
  if (!content?.catalogs || typeof content.catalogs !== 'object') {
    return {};
  }

  const result: Record<string, Record<string, string>> = {};
  for (const [name, entries] of Object.entries(content.catalogs)) {
    if (entries && typeof entries === 'object') {
      result[name] = entries as Record<string, string>;
    }
  }
  return result;
}

/**
 * Discover workspace and collect root + sub-package package.json data.
 * Returns undefined if the path is not a workspace.
 * Accepts an optional pre-computed workspace discovery result to avoid redundant filesystem walks.
 */
export async function collectWorkspacePackageJsons(
  repoPath: string,
  cachedWorkspace?: WorkspaceDiscovery,
): Promise<Array<{ path: string; relDir: string; packageJson: Record<string, any> }> | undefined> {
  try {
    const ws = cachedWorkspace ?? (await discoverWorkspace(repoPath));
    const rootPkgJson = await Bun.file(join(repoPath, 'package.json')).json();
    return [
      { path: join(repoPath, 'package.json'), relDir: '.', packageJson: rootPkgJson },
      ...ws.packages
        .filter(p => p.dir !== repoPath && p.dir !== ws.root)
        .map(p => ({
          path: join(p.dir, 'package.json'),
          relDir: relative(repoPath, p.dir) || '.',
          packageJson: p.packageJson as Record<string, any>,
        })),
    ];
  } catch {
    // Not a workspace (standalone project)
    return undefined;
  }
}
