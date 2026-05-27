import { join } from 'node:path';

import type { PendingUpdate, VersionEntry } from '../types';
import type { PackageManager } from './pm-detect';

import { findCatalogRoot, updateCatalogVersion, removeCatalogEntry } from './catalog';
import { NpmrcConflictError } from './errors';
import { atomicWrite } from './fs';
import { patchPnpmLockfile } from './lockfile-patch';
import { log } from './log';
import { pmCommand, run } from './proc';
import { getActiveRepos } from './repo-state';

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
    if (startIdx === -1 || endIdx === -1) {
      break;
    }
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

type HookTarget = { type: 'husky'; path: string } | { type: 'lefthook' } | { type: 'git'; path: string };

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
      await removeCatalogEntry(catalogResult.root, pkgName, catalogName, catalogFormat ?? catalogResult.format);
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

/**
 * Recover from a crash that left a consumer in a dirty state.
 * If pendingUpdate exists on a repo state, the previous install was interrupted
 * between writing version changes and completing the install. We roll back the
 * version changes to their originals and clear the pending marker.
 */
export async function recoverPendingUpdate(repoPath: string, pending: PendingUpdate): Promise<{ recovered: string[] }> {
  const recovered: string[] = [];

  // Roll back package.json version changes
  for (const [pkgName, targets] of Object.entries(pending.packages)) {
    for (const t of targets) {
      const targetPath = join(repoPath, t.dir);
      if (t.original === '') {
        await removePackageJsonDependency(targetPath, pkgName);
      } else {
        await updatePackageJsonVersion(targetPath, pkgName, t.original);
      }
    }
    recovered.push(pkgName);
  }

  // Roll back catalog changes
  if (pending.catalogs) {
    const catalogResult = await findCatalogRoot(repoPath);
    if (catalogResult) {
      for (const [pkgName, entry] of Object.entries(pending.catalogs)) {
        if (entry.original === '') {
          await removeCatalogEntry(catalogResult.root, pkgName, entry.catalogName, entry.catalogFormat);
        } else {
          await updateCatalogVersion(
            catalogResult.root,
            pkgName,
            entry.original,
            entry.catalogName,
            entry.catalogFormat,
          );
        }
        if (!recovered.includes(pkgName)) {
          recovered.push(pkgName);
        }
      }
    }
  }

  return { recovered };
}
