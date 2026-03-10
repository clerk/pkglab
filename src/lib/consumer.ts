import { join } from 'node:path';

import type { PublishPlan, PublishEntry, RepoEntry, RepoState } from '../types';
import type { PackageManager } from './pm-detect';

import { NpmrcConflictError } from './errors';
import { atomicWrite } from './fs';
import { patchPnpmLockfile } from './lockfile-patch';
import { log } from './log';
import { detectPackageManager } from './pm-detect';
import { pmCommand, run } from './proc';
import { getActiveRepos } from './repo-state';

export type { LockfilePatchEntry } from './lockfile-patch';

export const MARKER_START = '# pkglab-start';
const MARKER_END = '# pkglab-end';

export async function addRegistryToNpmrc(repoPath: string, port: number): Promise<{ isFirstTime: boolean }> {
  const npmrcPath = join(repoPath, '.npmrc');
  const file = Bun.file(npmrcPath);
  let content = '';
  let isFirstTime = true;

  if (await file.exists()) {
    content = await file.text();

    if (content.includes(MARKER_START)) {
      isFirstTime = false;
      content = removepkglabBlock(content);
    }

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('registry=') && !trimmed.includes('localhost') && !trimmed.includes('127.0.0.1')) {
        throw new NpmrcConflictError(`Existing registry in .npmrc: ${trimmed}\npkglab cannot override this.`);
      }
    }
  }

  const block = `${MARKER_START}\nregistry=http://127.0.0.1:${port}\n${MARKER_END}`;
  content = content.trimEnd() + '\n' + block + '\n';
  await atomicWrite(npmrcPath, content);

  return { isFirstTime };
}

export async function removeRegistryFromNpmrc(repoPath: string): Promise<void> {
  const npmrcPath = join(repoPath, '.npmrc');
  const file = Bun.file(npmrcPath);
  if (!(await file.exists())) {
    return;
  }

  let content = await file.text();
  content = removepkglabBlock(content);
  await atomicWrite(npmrcPath, content);
}

export function removepkglabBlock(content: string): string {
  let result = content;
  while (true) {
    const startIdx = result.indexOf(MARKER_START);
    const endIdx = result.indexOf(MARKER_END, startIdx + MARKER_START.length);
    if (startIdx === -1 || endIdx === -1) break;
    const before = result.slice(0, startIdx);
    const after = result.slice(endIdx + MARKER_END.length);
    result = before + after;
  }
  return result.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export async function removeSkipWorktree(repoPath: string): Promise<void> {
  if (!(await isTrackedByGit(repoPath, '.npmrc'))) {
    return;
  }

  const result = await run(['git', 'update-index', '--no-skip-worktree', '.npmrc'], {
    cwd: repoPath,
  });
  if (result.exitCode !== 0) {
    log.warn(`Failed to clear skip-worktree on .npmrc: ${result.stderr.trim()}`);
  }
}

async function isTrackedByGit(repoPath: string, file: string): Promise<boolean> {
  const result = await run(['git', 'ls-files', file], { cwd: repoPath });
  return result.stdout.trim().length > 0;
}

// --- Pre-commit hook injection ---

const HOOK_BLOCK = `${MARKER_START}\nnpx pkglab check\n${MARKER_END}\n`;

type HookTarget =
  | { type: 'husky'; path: string }
  | { type: 'lefthook' }
  | { type: 'git'; path: string };

async function detectHookTarget(repoPath: string): Promise<HookTarget> {
  const { stat } = await import('node:fs/promises');

  // 1. Husky: .husky/pre-commit
  const huskyPath = join(repoPath, '.husky', 'pre-commit');
  if (await Bun.file(huskyPath).exists()) {
    return { type: 'husky', path: huskyPath };
  }

  // 2. Lefthook: lefthook.yml or .lefthook/pre-commit/ directory
  const lefthookYml = join(repoPath, 'lefthook.yml');
  if (await Bun.file(lefthookYml).exists()) {
    return { type: 'lefthook' };
  }
  const lefthookDir = join(repoPath, '.lefthook', 'pre-commit');
  try {
    const s = await stat(lefthookDir);
    if (s.isDirectory()) {
      return { type: 'lefthook' };
    }
  } catch {
    // Directory doesn't exist, fall through
  }

  // 3. Raw git: .git/hooks/pre-commit
  const gitHookPath = join(repoPath, '.git', 'hooks', 'pre-commit');
  return { type: 'git', path: gitHookPath };
}

export async function injectPreCommitHook(repoPath: string): Promise<void> {
  const target = await detectHookTarget(repoPath);

  if (target.type === 'lefthook') {
    log.warn(
      'Lefthook detected. Add pkglab check to your lefthook config manually:\n' +
        '  pre-commit:\n' +
        '    commands:\n' +
        '      pkglab-check:\n' +
        '        run: npx pkglab check',
    );
    return;
  }

  const hookPath = target.path;
  const file = Bun.file(hookPath);
  let content = '';

  if (await file.exists()) {
    content = await file.text();
    if (content.includes(MARKER_START)) {
      // Already injected
      return;
    }
  } else {
    // Create the hook file with a shebang
    content = '#!/bin/sh\n';
  }

  // Append the marker block
  content = content.trimEnd() + '\n' + HOOK_BLOCK;
  await Bun.write(hookPath, content);

  // Ensure the file is executable
  const { chmod } = await import('node:fs/promises');
  await chmod(hookPath, 0o755);

  log.info(`Injected pkglab check into ${target.type} pre-commit hook`);
}

export async function removePreCommitHook(repoPath: string): Promise<void> {
  const target = await detectHookTarget(repoPath);

  if (target.type === 'lefthook') {
    // Nothing to remove automatically for lefthook
    return;
  }

  const hookPath = target.path;
  const file = Bun.file(hookPath);

  if (!(await file.exists())) {
    return;
  }

  let content = await file.text();
  if (!content.includes(MARKER_START)) {
    return;
  }

  content = removepkglabBlock(content);

  // If the hook is now empty (only shebang or whitespace), remove the file for raw git hooks
  const stripped = content.replace(/^#!.*\n?/, '').trim();
  if (target.type === 'git' && stripped.length === 0) {
    const { unlink } = await import('node:fs/promises');
    await unlink(hookPath).catch(() => {});
  } else {
    await Bun.write(hookPath, content);
  }

  log.info('Removed pkglab check from pre-commit hook');
}

export async function updatePackageJsonVersion(
  repoPath: string,
  pkgName: string,
  version: string,
): Promise<{ previousVersion: string | null }> {
  const pkgJsonPath = join(repoPath, 'package.json');
  const pkgJson = await Bun.file(pkgJsonPath).json();

  let previousVersion: string | null = null;
  let found = false;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkgJson[field]?.[pkgName]) {
      previousVersion = pkgJson[field][pkgName];
      pkgJson[field][pkgName] = version;
      found = true;
    }
  }

  // Upsert: if not found in any field, add to dependencies
  if (!found) {
    if (!pkgJson.dependencies) {
      pkgJson.dependencies = {};
    }
    pkgJson.dependencies[pkgName] = version;
  }

  await atomicWrite(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
  return { previousVersion };
}

export async function removePackageJsonDependency(repoPath: string, pkgName: string): Promise<void> {
  const pkgJsonPath = join(repoPath, 'package.json');
  const pkgJson = await Bun.file(pkgJsonPath).json();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkgJson[field]?.[pkgName]) {
      delete pkgJson[field][pkgName];
    }
  }
  await atomicWrite(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
}

/**
 * Restore a single package to its original version. Handles catalog entries,
 * packages with original versions, and packages that were added by pkglab
 * (no original version, so the dependency is removed).
 */
export async function restorePackage(
  repoPath: string,
  pkgName: string,
  targets: Array<{ dir: string; original: string }>,
  catalogName?: string,
  catalogFormat?: 'package-json' | 'pnpm-workspace',
): Promise<void> {
  if (catalogName) {
    const catalogResult = await findCatalogRoot(repoPath);
    const original = targets[0]?.original ?? '';
    if (catalogResult && original) {
      await updateCatalogVersion(
        catalogResult.root,
        pkgName,
        original,
        catalogName,
        catalogFormat ?? catalogResult.format,
      );
      log.info(`Restored ${pkgName} to ${original} (catalog)`);
    } else if (catalogResult && !original) {
      await removeCatalogEntry(
        catalogResult.root,
        pkgName,
        catalogName,
        catalogFormat ?? catalogResult.format,
      );
      log.info(`Removed ${pkgName} from catalog (was added by pkglab, no original version)`);
    } else if (!catalogResult) {
      log.warn(`Could not find catalog root for ${pkgName}, restoring in package.json`);
      if (original) {
        const targetDir = join(repoPath, targets[0]?.dir ?? '.');
        await updatePackageJsonVersion(targetDir, pkgName, original);
      }
    }
    return;
  }
  for (const t of targets) {
    const targetDir = join(repoPath, t.dir);
    if (t.original) {
      await updatePackageJsonVersion(targetDir, pkgName, t.original);
    } else {
      await removePackageJsonDependency(targetDir, pkgName);
    }
  }
  const firstOriginal = targets[0]?.original;
  if (firstOriginal) {
    log.info(`Restored ${pkgName} to ${firstOriginal}`);
  } else {
    log.info(`Removed ${pkgName} (was added by pkglab, no original version)`);
  }
}

export type CatalogFormat = 'package-json' | 'pnpm-workspace';

export interface VersionEntry {
  name: string;
  version: string;
  catalogName?: string;
  catalogFormat?: CatalogFormat;
  targets: Array<{ dir: string }>;
}

interface InstallWithVersionUpdatesOpts {
  repoPath: string;
  catalogRoot?: string;
  entries: VersionEntry[];
  pm: PackageManager;
  registryUrl?: string;
  patchEntries?: import('./lockfile-patch').LockfilePatchEntry[];
  noPmOptimizations?: boolean;
  onCommand?: (cmd: string[], cwd: string) => void;
  onLockfilePatched?: (entryCount: number) => void;
}

const LOCALHOST_URL_RE = /"http:\/\/(?:127\.0\.0\.1|localhost):[^"]*"/g;

async function sanitizeBunLockfile(dir: string): Promise<void> {
  const lockPath = join(dir, 'bun.lock');
  const lockFile = Bun.file(lockPath);
  if (!(await lockFile.exists())) {
    return;
  }
  const content = await lockFile.text();
  LOCALHOST_URL_RE.lastIndex = 0;
  if (!LOCALHOST_URL_RE.test(content)) {
    return;
  }
  await Bun.write(lockPath, content.replace(LOCALHOST_URL_RE, '""'));
}

/**
 * Write version updates to package.json or catalog, run install, and
 * rollback on failure. Returns a map of package name to targets with previous versions.
 */
export async function installWithVersionUpdates(
  opts: InstallWithVersionUpdatesOpts,
): Promise<Map<string, Array<{ dir: string; original: string }>>> {
  const { repoPath, catalogRoot, entries, pm, onCommand } = opts;
  const previousVersions = new Map<string, Array<{ dir: string; original: string }>>();

  // Step 1: write version updates
  for (const entry of entries) {
    if (entry.catalogName && catalogRoot) {
      const { previousVersion } = await updateCatalogVersion(
        catalogRoot,
        entry.name,
        entry.version,
        entry.catalogName,
        entry.catalogFormat,
      );
      previousVersions.set(
        entry.name,
        entry.targets.map(t => ({
          dir: t.dir,
          original: previousVersion ?? '',
        })),
      );
    } else {
      const targets: Array<{ dir: string; original: string }> = [];
      for (const t of entry.targets) {
        const targetPath = join(repoPath, t.dir);
        const { previousVersion } = await updatePackageJsonVersion(targetPath, entry.name, entry.version);
        targets.push({ dir: t.dir, original: previousVersion ?? '' });
      }
      previousVersions.set(entry.name, targets);
    }
  }

  // Fast path: for pnpm, try lockfile patching to skip resolution
  if (!opts.noPmOptimizations && pm === 'pnpm' && opts.patchEntries && opts.patchEntries.length > 0) {
    const patchDir = catalogRoot ?? repoPath;
    const patched = await patchPnpmLockfile(patchDir, opts.patchEntries);
    if (patched) {
      opts.onLockfilePatched?.(opts.patchEntries.length);
      return previousVersions;
    }
    // Patch failed (lockfile restored), fall through to regular install
  }

  // Step 2: determine install command - always use pm install
  // Versions are already written to package.json/catalog in step 1.
  // pm install syncs node_modules from the updated manifests.
  // --ignore-scripts: pkglab only swaps tarball versions of already-installed
  // packages, so lifecycle scripts (postinstall, prepare) are unnecessary.
  // If install fails with --ignore-scripts, retry without it as a fallback.
  const baseArgs = opts.noPmOptimizations ? ['install'] : ['install', '--ignore-scripts'];
  if (!opts.noPmOptimizations && (pm === 'pnpm' || pm === 'bun')) {
    baseArgs.push('--prefer-offline');
  }
  const cwd: string = catalogRoot ?? repoPath;

  // Step 3: build a clean env for install.
  // pnpm injects npm_config_* env vars into child processes. npm_config_registry
  // overrides .npmrc (env vars > project .npmrc in npm's config precedence), so
  // the registry URL pkglab writes to .npmrc gets ignored. Strip npm_config_registry
  // and set it explicitly to our local registry when a registryUrl is provided.
  let registryEnv: Record<string, string | undefined> | undefined;
  if (opts.registryUrl) {
    registryEnv = { npm_config_registry: opts.registryUrl };
  }

  // Build command + env using pmCommand so bun routes through process.execPath + BUN_BE_BUN
  const { cmd: installCmd, env: baseEnv } = pmCommand(pm, baseArgs, registryEnv);
  // Strip inherited npm_config_registry when we're overriding it
  if (opts.registryUrl) {
    delete baseEnv.npm_config_registry;
    baseEnv.npm_config_registry = opts.registryUrl;
  }

  // Step 4: disable bun manifest cache if needed
  const restoreBunfig = pm === 'bun' ? await disableBunManifestCache(cwd) : null;

  try {
    // Step 5: notify caller
    onCommand?.([pm, ...baseArgs], cwd);

    // Step 6: run install (fast path with --ignore-scripts unless noPmOptimizations)
    let result = await run(installCmd, { cwd, env: baseEnv });

    // Step 6b: fallback without --ignore-scripts if the fast path failed
    if (!opts.noPmOptimizations && result.exitCode !== 0) {
      const fallbackArgs = baseArgs.filter(a => a !== '--ignore-scripts');
      const { cmd: fallbackCmd } = pmCommand(pm, fallbackArgs);
      result = await run(fallbackCmd, { cwd, env: baseEnv });
    }

    // Step 6: rollback on failure
    if (result.exitCode !== 0) {
      for (const entry of entries) {
        const prevTargets = previousVersions.get(entry.name) ?? [];
        if (entry.catalogName && catalogRoot) {
          const prev = prevTargets[0]?.original ?? null;
          if (prev !== null && prev !== '') {
            await updateCatalogVersion(catalogRoot, entry.name, prev, entry.catalogName, entry.catalogFormat);
          } else {
            await removeCatalogEntry(catalogRoot, entry.name, entry.catalogName, entry.catalogFormat);
          }
        } else {
          for (const t of prevTargets) {
            const targetPath = join(repoPath, t.dir);
            if (t.original === '') {
              await removePackageJsonDependency(targetPath, entry.name);
            } else {
              await updatePackageJsonVersion(targetPath, entry.name, t.original);
            }
          }
        }
      }
      const output = (result.stderr || result.stdout).trim();
      throw new Error(`Install failed (${pm}): ${output}`);
    }
  } finally {
    // Step 7: restore bunfig
    await restoreBunfig?.();
  }

  // Step 8: sanitize bun.lock to remove localhost registry URLs
  if (pm === 'bun') {
    await sanitizeBunLockfile(cwd);
  }

  // Step 9: return previous versions
  return previousVersions;
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

export interface CatalogData {
  catalog?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
  [key: string]: unknown;
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

export async function ensureNpmrcForActiveRepos(port: number): Promise<void> {
  const activeRepos = await getActiveRepos();
  for (const { displayName, state } of activeRepos) {
    if (Object.keys(state.packages).length === 0) {
      continue;
    }
    const npmrcFile = Bun.file(join(state.path, '.npmrc'));
    const exists = await npmrcFile.exists();
    const hasBlock = exists && (await npmrcFile.text()).includes(MARKER_START);
    if (!hasBlock) {
      try {
        await addRegistryToNpmrc(state.path, port);
        log.dim(`  Repaired .npmrc for ${displayName}`);
      } catch {
        log.warn(`Could not repair .npmrc for ${displayName}`);
      }
    }
  }
}

const BUNFIG_MARKER = '\n# pkglab-manifest-override\n';

/**
 * Temporarily append [install.cache] disableManifest = true to the consumer's
 * bunfig.toml so bun skips its 5-minute metadata cache and sees freshly
 * published versions. Returns a restore function.
 */
async function disableBunManifestCache(dir: string): Promise<() => Promise<void>> {
  const path = join(dir, 'bunfig.toml');
  const file = Bun.file(path);
  const original = (await file.exists()) ? await file.text() : null;

  const override = `${BUNFIG_MARKER}[install.cache]\ndisableManifest = true\n`;
  await Bun.write(path, (original ?? '') + override);

  return async () => {
    if (original === null) {
      const { unlink } = await import('node:fs/promises');
      await unlink(path).catch(() => {});
    } else {
      await Bun.write(path, original);
    }
  };
}

export interface RepoWorkItem {
  displayName: string;
  state: RepoState;
  pm: PackageManager;
  packages: PublishEntry[];
}

/**
 * Build per-repo work items: which packages to update and the package manager to use.
 * Filters to repos that have at least one package from the plan matching by tag.
 */
export async function buildConsumerWorkItems(plan: PublishPlan, tag?: string, preloadedRepos?: RepoEntry[]): Promise<RepoWorkItem[]> {
  const activeRepos = await getActiveRepos(preloadedRepos);
  if (activeRepos.length === 0) {
    return [];
  }

  const pubTag = tag ?? null;
  const repoWork = await Promise.all(
    activeRepos.map(async ({ displayName, state }) => {
      const pm = await detectPackageManager(state.path);
      const packages = plan.packages.filter(e => {
        const link = state.packages[e.name];
        if (!link) {
          return false;
        }
        const linkTag = link.tag ?? null;
        return linkTag === pubTag;
      });
      return { displayName, state, pm, packages };
    }),
  );
  return repoWork.filter(r => r.packages.length > 0);
}

export async function buildVersionEntries(
  repo: RepoWorkItem,
): Promise<{ entries: VersionEntry[]; catalogRoot: string | undefined }> {
  const entries: VersionEntry[] = repo.packages.map(e => {
    const link = repo.state.packages[e.name];
    return {
      name: e.name,
      version: e.version,
      catalogName: link?.catalogName,
      catalogFormat: link?.catalogFormat,
      targets: link?.targets.map(t => ({ dir: t.dir })) ?? [{ dir: '.' }],
    };
  });
  const catalogResult = entries.some(e => e.catalogName) ? await findCatalogRoot(repo.state.path) : null;
  return { entries, catalogRoot: catalogResult?.root };
}
