import { defineCommand } from 'citty';

import type { RepoWorkItem, LockfilePatchEntry } from '../lib/consumer';
import type { SpinnerLine } from '../lib/spinner';
import type { WorkspacePackage, PublishEntry, RepoEntry } from '../types';

import { getPositionalArgs } from '../lib/args';
import { type ChangeReason, type CascadeResult, runCascade } from '../lib/cascade';
import { c } from '../lib/color';
import { loadConfig } from '../lib/config';
import { buildConsumerWorkItems, buildVersionEntries, installWithVersionUpdates } from '../lib/consumer';
import { fetchIntegrityHashes } from '../lib/lockfile-patch';
import { ensureDaemonRunning } from '../lib/daemon';
import { CommandError, pkglabError } from '../lib/errors';
import { type PackageFingerprint } from '../lib/fingerprint';
import { saveFingerprintState } from '../lib/fingerprint-state';
import {
  buildDependencyGraph,
  precomputeTransitiveDeps,
} from '../lib/graph';
import { runPreHook, runPostHook, runErrorHook } from '../lib/hooks';
import { sendPublishRequest } from '../lib/publish-ping';
import { acquirePublishLock } from '../lib/lock';
import { log } from '../lib/log';
import { run } from '../lib/proc';
import { buildPublishPlan, executePublish } from '../lib/publisher';
import { setDistTag } from '../lib/registry';
import { saveRepoByPath } from '../lib/repo-state';
import { createMultiSpinner } from '../lib/spinner';
import { prefetchUpdateCheck } from '../lib/update-check';
import { generateVersion, sanitizeTag } from '../lib/version';
import { discoverWorkspace, findPackage, loadCatalogs } from '../lib/workspace';

async function resolveTag(args: Record<string, unknown>): Promise<string | undefined> {
  if (args.tag && args.worktree) {
    throw new pkglabError('Cannot use --tag and --worktree together');
  }

  if (args.worktree) {
    const result = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: process.cwd(),
    });
    const branch = result.stdout.trim();
    if (branch === 'HEAD') {
      throw new pkglabError('Cannot detect branch name, use --tag instead');
    }
    return sanitizeTag(branch);
  }

  if (args.tag) {
    return sanitizeTag(args.tag as string);
  }

  return undefined;
}

function resolveTargets(args: Record<string, unknown>, workspace: { packages: WorkspacePackage[] }): string[] {
  const names = getPositionalArgs(args);

  if (args.root && names.length > 0) {
    throw new pkglabError('Cannot use --root with package names');
  }

  if (names.length > 0) {
    const targets: string[] = [];
    for (const name of names) {
      const pkg = findPackage(workspace.packages, name);
      if (!pkg) {
        throw new CommandError(`Package not found in workspace: ${name}`);
      }
      if (!pkg.publishable) {
        throw new CommandError(`Package ${name} is private and cannot be published`);
      }
      targets.push(pkg.name);
    }
    return targets;
  }

  if (!args.root) {
    const cwd = process.cwd();
    const currentPkg = workspace.packages.find(p => p.dir === cwd);
    if (currentPkg) {
      if (!currentPkg.publishable) {
        throw new CommandError('Current package is private and cannot be published');
      }
      log.info(`Publishing from package dir: ${currentPkg.name}`);
      return [currentPkg.name];
    }
  }

  return workspace.packages.filter(p => p.publishable).map(p => p.name);
}

function printScopeSummary(cascade: CascadeResult): void {
  const {
    cascadePackages,
    publishSet,
    unchangedSet,
    reason,
    targetSet,
    expandedFrom,
    allSkippedDependents,
    activeRepos,
  } = cascade;

  const toPublish = publishSet.length;
  const unchanged = unchangedSet.length;
  const total = cascadePackages.length;
  const parts = [`${toPublish} to publish`];
  if (unchanged > 0) {
    parts.push(`${unchanged} unchanged`);
  }
  log.info(`Scope: ${total} packages (${parts.join(', ')})`);
  log.line('');

  for (const pkg of cascadePackages) {
    const r = reason.get(pkg.name)!;
    const willPublish = r === 'changed' || r === 'propagated';

    // Scope reason: target, dependency (transitive dep of target), or dependent (via X)
    let scopeReason: string;
    if (targetSet.has(pkg.name)) {
      scopeReason = 'target';
    } else if (expandedFrom.has(pkg.name)) {
      scopeReason = `dependent (via ${expandedFrom.get(pkg.name)})`;
    } else {
      scopeReason = 'dependency';
    }

    const changeReason = r === 'changed' ? 'changed' : r === 'propagated' ? 'dep changed' : 'unchanged';
    if (willPublish) {
      log.line(`  ${c.green('\u25B2')} ${pkg.name}  ${scopeReason}, ${changeReason}`);
    } else {
      log.line(`  ${c.dim('\u00B7')} ${c.dim(pkg.name)}  ${c.dim(`${scopeReason}, ${changeReason}`)}`);
    }
  }

  for (const { name, via } of allSkippedDependents) {
    const label = activeRepos.length > 0 ? 'no consumers' : 'no active repos';
    log.line(`  ${c.dim('\u00B7')} ${c.dim(name)}  ${c.dim(`dependent (via ${via}), ${label}`)}`);
  }
}

export default defineCommand({
  meta: { name: 'pub', description: 'Publish packages to local registry' },
  args: {
    name: { type: 'positional', description: 'Package name(s)', required: false },
    'dry-run': { type: 'boolean', description: 'Show what would be published', default: false },
    single: { type: 'boolean', description: 'Skip dep cascade', default: false },
    shallow: {
      type: 'boolean',
      description: 'Targets + deps only, no dependent expansion',
      default: false,
    },
    verbose: { type: 'boolean', description: 'Show detailed output', default: false, alias: 'v' },
    force: {
      type: 'boolean',
      description: 'Ignore fingerprints (republish all)',
      default: false,
      alias: 'f',
    },
    tag: { type: 'string', description: 'Publish with a tag', alias: 't' },
    worktree: {
      type: 'boolean',
      description: 'Auto-detect tag from git branch',
      default: false,
      alias: 'w',
    },
    root: {
      type: 'boolean',
      description: 'Publish all packages (skip per-package cwd detection)',
      default: false,
    },
    ping: {
      type: 'boolean',
      description: 'Send signal to listener instead of publishing',
      default: false,
    },
    'no-pm-optimizations': {
      type: 'boolean',
      description: 'Skip lockfile patching and other install optimizations',
      default: false,
    },
  },
  async run({ args }) {
    const tag = await resolveTag(args);
    const workspace = await discoverWorkspace(process.cwd());

    // --ping: fast path, POST to registry and exit
    if (args.ping) {
      await ensureDaemonRunning();
      const config = await loadConfig();
      const targets = resolveTargets(args, workspace);
      await sendPublishRequest(config.port, {
        workspaceRoot: workspace.root,
        targets,
        tag,
        root: args.root,
        force: args.force,
        single: args.single,
        shallow: args.shallow,
        dryRun: args['dry-run'],
      });
      log.success('Publish request sent to registry');
      return;
    }

    // Normal publish path
    const verbose = args.verbose;
    const showUpdate = await prefetchUpdateCheck();

    if (verbose && tag) {
      log.info(`Publishing with tag: ${tag}`);
    }

    await ensureDaemonRunning();
    log.dim('Using pkglab registry server');

    const config = await loadConfig();
    if (verbose) {
      log.info(`Found ${workspace.packages.length} packages in workspace`);
    }

    const targets = resolveTargets(args, workspace);

    // --single bypasses cascade and fingerprinting entirely
    if (args.single) {
      const publishSet = targets
        .map(name => findPackage(workspace.packages, name))
        .filter(Boolean) as typeof workspace.packages;

      await publishPackages(
        publishSet,
        [],
        workspace.root,
        config,
        tag,
        verbose,
        args['dry-run'],
        new Map(),
        undefined,
        undefined,
        undefined,
        workspace.packages,
        args['no-pm-optimizations'],
      );
      await showUpdate();
      return;
    }

    const cascade = await runCascade(targets, workspace, tag, {
      verbose,
      shallow: args.shallow,
      force: args.force,
    });

    printScopeSummary(cascade);

    if (cascade.publishSet.length === 0) {
      log.line('');
      log.success('Nothing to publish');
      await showUpdate();
      return;
    }
    log.line('');

    const publishTiming = await publishPackages(
      cascade.publishSet,
      cascade.unchangedSet,
      workspace.root,
      config,
      tag,
      verbose,
      args['dry-run'],
      cascade.existingVersions,
      cascade.reason,
      cascade.fingerprints,
      cascade.cascadePackages,
      workspace.packages,
      args['no-pm-optimizations'],
      cascade.activeRepos,
    );

    if (verbose && publishTiming) {
      const pu = Math.round(publishTiming.publishMs);
      const co = Math.round(publishTiming.consumerMs);
      log.dim(`Timing: publish ${pu}ms, consumer ${co}ms`);
    }

    await showUpdate();
  },
});

interface PublishTiming {
  publishMs: number;
  consumerMs: number;
}

async function publishPackages(
  publishSet: WorkspacePackage[],
  unchangedSet: WorkspacePackage[],
  workspaceRoot: string,
  config: { port: number; prune_keep: number },
  tag: string | undefined,
  verbose: boolean,
  dryRun: boolean,
  existingVersions: Map<string, string> = new Map(),
  reason?: Map<string, ChangeReason>,
  fingerprints?: Map<string, PackageFingerprint>,
  allCascadePackages?: WorkspacePackage[],
  workspacePackages?: WorkspacePackage[],
  noPmOptimizations = false,
  preloadedActiveRepos?: RepoEntry[],
): Promise<PublishTiming | undefined> {
  const catalogs = await loadCatalogs(workspaceRoot);

  if (dryRun) {
    const version = generateVersion(tag);
    const plan = buildPublishPlan(publishSet, version, catalogs, existingVersions);

    // Scope summary already printed for cascade path; show "Will publish" only for --single
    if (!reason) {
      log.info(`Will publish ${plan.packages.length} packages:`);
    }
    for (const entry of plan.packages) {
      const r = reason?.get(entry.name);
      if (verbose && r) {
        const detail = r === 'propagated' ? ' (dep changed)' : ' (content changed)';
        log.line(`  ${c.green('\u2714')} ${entry.name}@${entry.version}${detail}`);
      } else {
        log.line(`  ${c.green('\u2714')} ${entry.name}@${entry.version}`);
      }
    }
    for (const pkg of unchangedSet) {
      const ver = existingVersions.get(pkg.name) ?? 'unknown';
      log.line(`  ${c.dim('\u25CB')} ${c.dim(`${pkg.name} (unchanged, ${ver})`)}`);
    }
    return;
  }

  const version = generateVersion(tag);
  const plan = buildPublishPlan(publishSet, version, catalogs, existingVersions);

  // Scope summary already printed for cascade path; show "Will publish" only for --single
  if (!reason) {
    log.info(`Will publish ${plan.packages.length} packages:`);
  }

  // Build consumer work items before publishing so we can stream installs
  const consumerWork = await buildConsumerWorkItems(plan, tag, preloadedActiveRepos);

  // Compute the required set for each repo: which packages from the publish batch
  // must be in the registry before the repo's install can succeed.
  // This includes direct packages and their transitive workspace deps.
  const requiredSets = new Map<RepoWorkItem, Set<string>>();
  if (consumerWork.length > 0 && workspacePackages) {
    const graph = buildDependencyGraph(workspacePackages);
    const transitiveDeps = precomputeTransitiveDeps(graph);
    const publishNames = new Set(plan.packages.map(p => p.name));

    for (const repo of consumerWork) {
      const required = new Set<string>();
      for (const entry of repo.packages) {
        if (publishNames.has(entry.name)) {
          required.add(entry.name);
        }
        const deps = transitiveDeps.get(entry.name) ?? [];
        for (const dep of deps) {
          if (publishNames.has(dep)) {
            required.add(dep);
          }
        }
      }
      requiredSets.set(repo, required);
    }
  }

  const releaseLock = await acquirePublishLock();
  let publishMs = 0;
  let consumerMs = 0;

  // Integrity hash fetcher for pnpm lockfile patching.
  // Each call fetches fresh from the registry so that packages published after
  // an earlier consumer repo triggered its install are included. Without this,
  // the first repo to call getIntegrityMap() would cache a promise that misses
  // packages still being published, causing stale integrity in later repos.
  // Disabled by --no-pm-optimizations.
  const getIntegrityMap: (() => Promise<Map<string, string>>) | undefined = noPmOptimizations
    ? undefined
    : () =>
        fetchIntegrityHashes(
          config.port,
          plan.packages.map(e => ({ name: e.name, version: e.version })),
        );

  const successfulEntries: PublishEntry[] = [];

  try {
    const publishStart = performance.now();

    if (verbose) {
      // Verbose mode: log messages as they happen, no unified spinner
      for (const entry of plan.packages) {
        const r = reason?.get(entry.name);
        if (r) {
          const detail = r === 'propagated' ? ' (dep changed)' : ' (content changed)';
          log.line(`  ${c.green('\u2714')} ${entry.name}@${entry.version}${detail}`);
        } else {
          log.line(`  - ${entry.name}@${entry.version}`);
        }
      }
      for (const pkg of unchangedSet) {
        const ver = existingVersions.get(pkg.name) ?? 'unknown';
        log.line(`  ${c.dim('\u25CB')} ${c.dim(`${pkg.name} (unchanged, ${ver})`)}`);
      }

      // Streaming consumer updates in verbose mode
      const publishedPackages = new Set<string>();
      const pendingRepos = new Set(consumerWork);
      const repoInstallPromises: Promise<void>[] = [];
      let consumerStart = 0;

      const executeStart = performance.now();
      await executePublish(
        plan,
        config,
        {
          verbose: true,
          onPackagePublished(entry: PublishEntry) {
            publishedPackages.add(entry.name);
            successfulEntries.push(entry);
            for (const repo of pendingRepos) {
              const required = requiredSets.get(repo);
              if (!required) {
                continue;
              }
              const allReady = [...required].every(name => publishedPackages.has(name));
              if (allReady) {
                pendingRepos.delete(repo);
                if (consumerStart === 0) {
                  consumerStart = performance.now();
                }
                log.info(`Starting install for ${repo.displayName}`);
                repoInstallPromises.push(
                  runRepoInstall(repo, { tag, port: config.port, verbose: true }, getIntegrityMap, noPmOptimizations, n => {
                    log.dim(`  lockfile patched (${n} entries, frozen install)`);
                  }).then(status => {
                    if (status === 'ok') {
                      log.success(`  ${repo.displayName}: updated ${repo.packages.map(e => e.name).join(', ')}`);
                    }
                  }).catch(err => {
                    log.error(`  ${repo.displayName}: install failed`);
                    throw err;
                  }),
                );
              }
            }
          },
        },
      );
      publishMs = performance.now() - executeStart;

      // Mark repos that depend on failed packages
      for (const repo of pendingRepos) {
        const required = requiredSets.get(repo);
        if (required) {
          const missing = [...required].filter(name => !publishedPackages.has(name));
          if (missing.length > 0) {
            log.warn(`Skipped ${repo.displayName} (publish failed for ${missing.join(', ')})`);
          }
        }
      }

      // Wait for any in-flight consumer installs
      await Promise.all(repoInstallPromises);
      consumerMs = consumerStart > 0 ? performance.now() - consumerStart : 0;
    } else {
      // Non-verbose: unified spinner with publish lines + consumer repo lines
      log.info('Publishing...');
      const spinnerLines: SpinnerLine[] = plan.packages.map(e => `${e.name}@${e.version}`);

      // Add consumer repo lines to the spinner (header + per-package lines)
      const repoPackageIndices = new Map<RepoWorkItem, number[]>();

      const repoLockfileIndex = new Map<RepoWorkItem, number>();

      for (const repo of consumerWork) {
        spinnerLines.push({ text: `${repo.displayName} ${c.dim(repo.state.path)}`, header: true });
        if (repo.pm === 'pnpm') {
          repoLockfileIndex.set(repo, spinnerLines.length);
          spinnerLines.push('patching lockfile');
        }
        const indices: number[] = [];
        for (const entry of repo.packages) {
          indices.push(spinnerLines.length);
          spinnerLines.push(`waiting for ${entry.name}`);
        }
        repoPackageIndices.set(repo, indices);
      }

      const spinner = createMultiSpinner(spinnerLines);
      spinner.start();

      const publishedPackages = new Set<string>();
      const pendingRepos = new Set(consumerWork);
      const repoInstallPromises: Promise<void>[] = [];
      let consumerStart = 0;

      try {
        const executeStart = performance.now();
        await executePublish(
          plan,
          config,
          {
            onPublished: i => spinner.complete(i),
            onFailed: i => spinner.fail(i),
            onPackagePublished(entry: PublishEntry) {
              publishedPackages.add(entry.name);
              successfulEntries.push(entry);
              for (const repo of pendingRepos) {
                const required = requiredSets.get(repo);
                if (!required) {
                  continue;
                }
                const allReady = [...required].every(name => publishedPackages.has(name));
                if (allReady) {
                  pendingRepos.delete(repo);
                  if (consumerStart === 0) {
                    consumerStart = performance.now();
                  }
                  const indices = repoPackageIndices.get(repo)!;
                  for (const idx of indices) {
                    spinner.setText(idx, `installing ${repo.packages[indices.indexOf(idx)].name}`);
                  }
                  repoInstallPromises.push(
                    runRepoInstall(repo, { tag, port: config.port, verbose: false }, getIntegrityMap, noPmOptimizations, n => {
                      const lfIdx = repoLockfileIndex.get(repo);
                      if (lfIdx !== undefined) {
                        spinner.setText(lfIdx, `lockfile patched (${n} entries, frozen install)`);
                        spinner.complete(lfIdx);
                      }
                    }).then(status => {
                        const lfIdx = repoLockfileIndex.get(repo);
                        if (lfIdx !== undefined) {
                          spinner.complete(lfIdx);
                        }
                        if (status === 'skipped') {
                          for (let i = 0; i < repo.packages.length; i++) {
                            spinner.setText(indices[i], `skipped ${repo.packages[i].name} (hook aborted)`);
                            spinner.fail(indices[i]);
                          }
                        } else {
                          for (let i = 0; i < repo.packages.length; i++) {
                            spinner.setText(indices[i], `updated ${repo.packages[i].name}`);
                            spinner.complete(indices[i]);
                          }
                        }
                      })
                      .catch(err => {
                        for (const idx of indices) {
                          spinner.fail(idx);
                        }
                        throw err;
                      }),
                  );
                }
              }
            },
          },
        );
        publishMs = performance.now() - executeStart;

        // Mark repos that depend on failed packages
        for (const repo of pendingRepos) {
          const required = requiredSets.get(repo);
          if (!required) {
            continue;
          }
          const missing = [...required].filter(name => !publishedPackages.has(name));
          if (missing.length > 0) {
            const indices = repoPackageIndices.get(repo)!;
            for (let i = 0; i < repo.packages.length; i++) {
              spinner.setText(indices[i], `skipped ${repo.packages[i].name}`);
              spinner.fail(indices[i]);
            }
          }
        }

        // Wait for any in-flight consumer installs
        await Promise.all(repoInstallPromises);
        consumerMs = consumerStart > 0 ? performance.now() - consumerStart : 0;
      } finally {
        spinner.stop();
      }
    }

    const elapsed = ((performance.now() - publishStart) / 1000).toFixed(2);
    log.success(`Published ${plan.packages.length} packages in ${elapsed}s`);

    // Save fingerprint state AFTER consumer updates so a failed update retries on next pub
    if (fingerprints && allCascadePackages) {
      const entries = allCascadePackages.map(pkg => {
        const fp = fingerprints.get(pkg.name);
        const pkgVersion = existingVersions.get(pkg.name) ?? version;
        return {
          name: pkg.name,
          hash: fp?.hash ?? '',
          version: pkgVersion,
          fileStats: fp?.fileStats,
        };
      });
      await saveFingerprintState(workspaceRoot, tag ?? null, entries);
    }

    // Auto-prune old versions in detached subprocess
    Bun.spawn([process.execPath, '--__prune', String(config.port), String(config.prune_keep), ...(tag ? [tag] : [])], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    }).unref();

    return { publishMs, consumerMs };
  } finally {
    // Set dist-tags for successfully published packages even on partial failure,
    // so `pkglab add pkg@tag` works for packages that did publish
    if (successfulEntries.length > 0) {
      const distTag = tag ?? 'pkglab';
      await Promise.all(successfulEntries.map(e => setDistTag(config, e.name, e.version, distTag))).catch(err => {
        log.warn(`Failed to set dist-tags: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    await releaseLock();
  }
}

async function runRepoInstall(
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

  // Install and save state
  try {
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
