import type { PublishPlan, PublishEntry, RepoEntry, RepoState, VersionEntry } from '../types';
import type { LockfilePatchEntry } from './lockfile-patch';
import type { PackageManager } from './pm-detect';

import { findCatalogRoot } from './catalog';
import { installWithVersionUpdates } from './consumer';
import { runPreHook, runPostHook, runErrorHook } from './hooks';
import { log } from './log';
import { detectPackageManager } from './pm-detect';
import { getActiveRepos, saveRepoByPath } from './repo-state';

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
export async function buildConsumerWorkItems(
  plan: PublishPlan,
  tag?: string,
  preloadedRepos?: RepoEntry[],
): Promise<RepoWorkItem[]> {
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

export async function runRepoInstall(
  repo: RepoWorkItem,
  hookOpts?: { tag: string | undefined; port: number; verbose: boolean },
  getIntegrityMap?: () => Promise<Map<string, string>>,
  noPmOptimizations = false,
  onLockfilePatched?: (entryCount: number) => void,
): Promise<'ok' | 'skipped'> {
  const { entries, catalogRoot } = await buildVersionEntries(repo);

  // Build hook context if hook opts provided
  const hookCtx = hookOpts
    ? {
        event: 'update' as const,
        packages: repo.packages.map(e => ({
          name: e.name,
          version: e.version,
          previous: repo.state.packages[e.name]?.current,
        })),
        tag: hookOpts.tag ?? null,
        repoPath: repo.state.path,
        registryUrl: `http://127.0.0.1:${hookOpts.port}`,
        packageManager: repo.pm,
      }
    : null;

  // Pre-update hook
  if (hookCtx) {
    const preResult = await runPreHook(hookCtx);
    if (preResult.status === 'ok') {
      log.success(`  pre-update (${(preResult.durationMs / 1000).toFixed(1)}s)`);
    } else if (preResult.status === 'aborted' || preResult.status === 'failed' || preResult.status === 'timed_out') {
      const label = preResult.status === 'timed_out' ? 'timed out' : `aborted (exit ${preResult.exitCode ?? 1})`;
      log.warn(`  pre-update ${label} - skipped`);
      await runErrorHook({
        ...hookCtx,
        error: { stage: 'pre-hook', message: `pre-update hook ${label}`, failedHook: 'pre-update' },
      });
      return 'skipped';
    }
  }

  // Build lockfile patch entries for pnpm repos.
  // Include ALL published packages (not just tracked ones) because the lockfile
  // may contain transitive pkglab dependencies that also need integrity updates.
  let patchEntries: LockfilePatchEntry[] | undefined;
  if (repo.pm === 'pnpm' && getIntegrityMap) {
    const integrityMap = await getIntegrityMap();
    if (integrityMap.size > 0) {
      // Pre-compute fallback for transitive deps not directly tracked
      const fallbackOldVersion = Object.values(repo.state.packages).find(p => p.current)?.current;
      patchEntries = [];
      for (const [name, integrity] of integrityMap) {
        const oldVersion = repo.state.packages[name]?.current ?? fallbackOldVersion;
        const newVersion = repo.packages.find(p => p.name === name)?.version ?? repo.packages[0].version;
        if (oldVersion) {
          patchEntries.push({ name, oldVersion, newVersion, integrity });
        }
      }
    }
  }

  // Install and save state.
  // Save pending state before install so crash recovery can detect dirty consumers.
  try {
    // Mark pending update before modifying consumer files.
    // Capture current versions so crash recovery can roll back.
    repo.state.pendingUpdate = {
      packages: Object.fromEntries(
        entries.map(e => {
          const link = repo.state.packages[e.name];
          return [
            e.name,
            e.targets.map(t => {
              const existingTarget = link?.targets.find(lt => lt.dir === t.dir);
              return { dir: t.dir, original: existingTarget?.original ?? link?.current ?? '' };
            }),
          ];
        }),
      ),
      timestamp: Date.now(),
    };
    await saveRepoByPath(repo.state.path, repo.state);

    await installWithVersionUpdates({
      repoPath: repo.state.path,
      catalogRoot,
      entries,
      pm: repo.pm,
      registryUrl: hookOpts ? `http://127.0.0.1:${hookOpts.port}` : undefined,
      patchEntries,
      noPmOptimizations,
      onLockfilePatched,
    });

    for (const entry of repo.packages) {
      const link = repo.state.packages[entry.name];
      if (link) {
        link.current = entry.version;
      }
    }
    // Clear pending state on success
    delete repo.state.pendingUpdate;
    await saveRepoByPath(repo.state.path, repo.state);
  } catch (err) {
    if (hookCtx) {
      const message = err instanceof Error ? err.message : String(err);
      await runErrorHook({
        ...hookCtx,
        error: { stage: 'operation', message, failedHook: null },
      });
    }
    throw err;
  }

  // Post-update hook
  if (hookCtx) {
    const postResult = await runPostHook(hookCtx);
    if (postResult.status === 'ok') {
      log.success(`  post-update (${(postResult.durationMs / 1000).toFixed(1)}s)`);
    } else if (postResult.status === 'failed' || postResult.status === 'timed_out') {
      const label = postResult.status === 'timed_out' ? 'timed out' : `failed (exit ${postResult.exitCode ?? 1})`;
      log.warn(`  post-update hook ${label}`);
    }
  }

  return 'ok';
}
