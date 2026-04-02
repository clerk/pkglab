import { join } from 'node:path';

import { atomicWrite } from './fs';

export type CatalogFormat = 'package-json' | 'pnpm-workspace';

export interface CatalogData {
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

/**
 * Walk up from startDir to find the nearest catalog definition.
 * Checks pnpm-workspace.yaml first, then package.json.
 */
export async function findCatalogRoot(startDir: string): Promise<{ root: string; format: CatalogFormat } | null> {
  let dir = startDir;
  while (true) {
    // Check pnpm-workspace.yaml first
    const wsFile = Bun.file(join(dir, 'pnpm-workspace.yaml'));
    if (await wsFile.exists()) {
      const { parse } = await import('yaml');
      const content = parse(await wsFile.text());
      if (content?.catalog || content?.catalogs) {
        return { root: dir, format: 'pnpm-workspace' };
      }
    }

    // Check package.json catalogs (bun/npm)
    const file = Bun.file(join(dir, 'package.json'));
    if (await file.exists()) {
      const pkgJson = await file.json();
      if (pkgJson.catalog || pkgJson.catalogs) {
        return { root: dir, format: 'package-json' };
      }
    }

    const parent = join(dir, '..');
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Load catalog data from either package.json or pnpm-workspace.yaml.
 */
export async function loadCatalogData(rootDir: string, format: CatalogFormat): Promise<CatalogData> {
  if (format === 'pnpm-workspace') {
    const { parse } = await import('yaml');
    const text = await Bun.file(join(rootDir, 'pnpm-workspace.yaml')).text();
    return parse(text) as CatalogData;
  }
  return Bun.file(join(rootDir, 'package.json')).json() as Promise<CatalogData>;
}

/**
 * Load named catalogs from pnpm-workspace.yaml.
 * Returns an empty object if the file doesn't exist or has no catalogs.
 */
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
 * Find which catalog (default or named) contains a given package.
 * Works for both package.json and pnpm-workspace.yaml data since they
 * share the same catalog/catalogs structure.
 * Returns null if the package isn't in any catalog.
 */
export function findCatalogEntry(data: CatalogData, pkgName: string): { catalogName: string; version: string } | null {
  if (data?.catalog?.[pkgName] !== undefined) {
    return { catalogName: 'default', version: data.catalog[pkgName] };
  }
  if (data?.catalogs) {
    for (const [name, entries] of Object.entries(data.catalogs)) {
      if (entries && typeof entries === 'object' && entries[pkgName] !== undefined) {
        return { catalogName: name, version: entries[pkgName] };
      }
    }
  }
  return null;
}

/**
 * Update a version in the workspace root catalog (or named catalog).
 * Dispatches to the right file format based on the format parameter.
 */
export async function updateCatalogVersion(
  rootDir: string,
  pkgName: string,
  version: string,
  catalogName: string,
  format: CatalogFormat = 'package-json',
): Promise<{ previousVersion: string | null }> {
  if (format === 'pnpm-workspace') {
    return updatePnpmCatalogVersion(rootDir, pkgName, version, catalogName);
  }
  return updatePackageJsonCatalogVersion(rootDir, pkgName, version, catalogName);
}

async function updatePackageJsonCatalogVersion(
  rootDir: string,
  pkgName: string,
  version: string,
  catalogName: string,
): Promise<{ previousVersion: string | null }> {
  const pkgJsonPath = join(rootDir, 'package.json');
  const pkgJson = await Bun.file(pkgJsonPath).json();

  let previousVersion: string | null = null;
  if (catalogName === 'default') {
    if (pkgJson.catalog?.[pkgName] !== undefined) {
      previousVersion = pkgJson.catalog[pkgName];
      pkgJson.catalog[pkgName] = version;
    }
  } else {
    if (pkgJson.catalogs?.[catalogName]?.[pkgName] !== undefined) {
      previousVersion = pkgJson.catalogs[catalogName][pkgName];
      pkgJson.catalogs[catalogName][pkgName] = version;
    }
  }

  await atomicWrite(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  return { previousVersion };
}

async function updatePnpmCatalogVersion(
  rootDir: string,
  pkgName: string,
  version: string,
  catalogName: string,
): Promise<{ previousVersion: string | null }> {
  const { parse, stringify } = await import('yaml');
  const wsPath = join(rootDir, 'pnpm-workspace.yaml');
  const text = await Bun.file(wsPath).text();
  const ws = parse(text);

  let previousVersion: string | null = null;
  if (catalogName === 'default') {
    if (ws.catalog?.[pkgName] !== undefined) {
      previousVersion = ws.catalog[pkgName];
      ws.catalog[pkgName] = version;
    }
  } else {
    if (ws.catalogs?.[catalogName]?.[pkgName] !== undefined) {
      previousVersion = ws.catalogs[catalogName][pkgName];
      ws.catalogs[catalogName][pkgName] = version;
    }
  }

  await atomicWrite(wsPath, stringify(ws));
  return { previousVersion };
}

/**
 * Remove a package entry from a catalog. Used when restoring or rolling back
 * a package that was freshly added by pkglab (no original version to restore).
 */
export async function removeCatalogEntry(
  rootDir: string,
  pkgName: string,
  catalogName: string,
  format: CatalogFormat = 'package-json',
): Promise<void> {
  if (format === 'pnpm-workspace') {
    const { parse, stringify } = await import('yaml');
    const wsPath = join(rootDir, 'pnpm-workspace.yaml');
    const text = await Bun.file(wsPath).text();
    const ws = parse(text);
    if (catalogName === 'default') {
      if (ws.catalog) {
        delete ws.catalog[pkgName];
      }
    } else {
      if (ws.catalogs?.[catalogName]) {
        delete ws.catalogs[catalogName][pkgName];
      }
    }
    await atomicWrite(wsPath, stringify(ws));
  } else {
    const pkgJsonPath = join(rootDir, 'package.json');
    const pkgJson = await Bun.file(pkgJsonPath).json();
    if (catalogName === 'default') {
      if (pkgJson.catalog) {
        delete pkgJson.catalog[pkgName];
      }
    } else {
      if (pkgJson.catalogs?.[catalogName]) {
        delete pkgJson.catalogs[catalogName][pkgName];
      }
    }
    await atomicWrite(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  }
}
