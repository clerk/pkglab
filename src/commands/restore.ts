import { defineCommand } from 'citty';

import { getPositionalArgs, normalizeScope } from '../lib/args';
import { loadConfig } from '../lib/config';
import { removeRegistryFromNpmrc, removePreCommitHook, removeSkipWorktree, restorePackage } from '../lib/consumer';
import { runPreHook, runPostHook, runErrorHook } from '../lib/hooks';
import { log } from '../lib/log';
import { detectPackageManager, runInstall } from '../lib/pm-detect';
import { canonicalRepoPath, findRepoByPath, saveRepoByPath } from '../lib/repo-state';
import { extractTag } from '../lib/version';
import { discoverWorkspace } from '../lib/workspace';

export default defineCommand({
  meta: {
    name: 'restore',
    description: 'Restore pkglab packages to their original versions',
  },
  args: {
    name: { type: 'positional', description: 'Package name(s)', required: false },
    all: { type: 'boolean', description: 'Restore all pkglab packages', default: false },
    scope: {
      type: 'string',
      description: 'Restore all packages matching a scope (e.g. clerk or @clerk)',
    },
    tag: {
      type: 'string',
      alias: 't',
      description: 'Only restore packages installed with this tag',
    },
  },
  async run({ args }) {
    const names = getPositionalArgs(args);
    const scope = args.scope as string | undefined;
    const tag = args.tag as string | undefined;

    // Validation
    if (scope && names.length > 0) {
      log.error('Cannot combine --scope with package names. Use one or the other.');
      process.exit(1);
    }

    const repoPath = await canonicalRepoPath(process.cwd());
    let repo = await findRepoByPath(repoPath);

    // Fallback: cwd might be a subdirectory, try workspace root
    if (!repo) {
      const ws = await discoverWorkspace(process.cwd());
      if (ws.root !== repoPath) {
        const wsPath = await canonicalRepoPath(ws.root);
        repo = await findRepoByPath(wsPath);
      }
    }

    if (!repo || Object.keys(repo.state.packages).length === 0) {
      log.warn('No pkglab packages in this repo');
      return;
    }

    // Determine which packages to restore
    let toRestore: string[];

    if (scope) {
      const prefix = normalizeScope(scope);
      if (!prefix) {
        log.error(`Invalid scope: "${scope}". Use a scope name like "clerk" or "@clerk".`);
        process.exit(1);
      }
      toRestore = Object.keys(repo.state.packages).filter(name => name.startsWith(prefix));
      if (toRestore.length === 0) {
        log.warn(`No pkglab packages matching scope '${prefix.slice(0, -1)}' in this repo`);
        return;
      }
    } else if (args.all) {
      toRestore = Object.keys(repo.state.packages);
    } else if (names.length > 0) {
      toRestore = names;
    } else {
      log.error('Specify package name(s), --scope, or --all');
      process.exit(1);
    }

    // Filter by tag if provided
    if (tag) {
      toRestore = toRestore.filter(name => {
        const link = repo.state.packages[name];
        if (!link) {
          return false;
        }
        // Check stored tag on the link
        if (link.tag === tag) {
          return true;
        }
        // Also check if the current version has the matching tag
        const versionTag = extractTag(link.current);
        return versionTag === tag;
      });
      if (toRestore.length === 0) {
        log.warn(`No pkglab packages with tag '${tag}' in this repo`);
        return;
      }
    }

    // Validate all names exist in repo state
    const missing = toRestore.filter(name => !repo.state.packages[name]);
    if (missing.length > 0) {
      for (const name of missing) {
        log.warn(`${name} is not linked via pkglab in this repo`);
      }
      toRestore = toRestore.filter(name => repo.state.packages[name]);
      if (toRestore.length === 0) {
        return;
      }
    }

    // Build hook context
    const config = await loadConfig();
    const pm = await detectPackageManager(repoPath);
    const hookPackages = toRestore.map(name => {
      const link = repo.state.packages[name];
      const original = link.targets[0]?.original || undefined;
      return { name, version: original ?? link.current, previous: link.current };
    });
    const hookCtx = {
      event: 'restore' as const,
      packages: hookPackages,
      tag: tag ?? null,
      repoPath,
      registryUrl: `http://127.0.0.1:${config.port}`,
      packageManager: pm,
    };

    // Pre-restore hook
    const preResult = await runPreHook(hookCtx);
    if (preResult.status === 'ok') {
      log.success(`pre-restore hook (${(preResult.durationMs / 1000).toFixed(1)}s)`);
    } else if (preResult.status === 'aborted' || preResult.status === 'failed' || preResult.status === 'timed_out') {
      const label = preResult.status === 'timed_out' ? 'timed out' : `failed (exit ${preResult.exitCode ?? 1})`;
      log.error(`pre-restore hook ${label}`);
      await runErrorHook({
        ...hookCtx,
        error: { stage: 'pre-hook', message: `pre-restore hook ${label}`, failedHook: 'pre-restore' },
      });
      process.exit(1);
    }

    // Restore each package, update state, clean up, install
    try {
      for (const name of toRestore) {
        const link = repo.state.packages[name];
        await restorePackage(repoPath, name, link.targets, link.catalogName, link.catalogFormat);
        delete repo.state.packages[name];
      }
      await saveRepoByPath(repo.state.path, repo.state);

      // Clean up .npmrc and pre-commit hook if no packages remain
      if (Object.keys(repo.state.packages).length === 0) {
        await removeRegistryFromNpmrc(repo.state.path);
        await removeSkipWorktree(repo.state.path);
        await removePreCommitHook(repo.state.path);
        log.info('All pkglab packages removed, .npmrc restored');
      }

      // Run pm install once
      await runInstall(repoPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await runErrorHook({
        ...hookCtx,
        error: { stage: 'operation', message, failedHook: null },
      });
      throw err;
    }

    // Post-restore hook
    const postResult = await runPostHook(hookCtx);
    if (postResult.status === 'ok') {
      log.success(`post-restore hook (${(postResult.durationMs / 1000).toFixed(1)}s)`);
    } else if (postResult.status === 'failed' || postResult.status === 'timed_out') {
      const label = postResult.status === 'timed_out' ? 'timed out' : `failed (exit ${postResult.exitCode ?? 1})`;
      log.warn(`post-restore hook ${label}`);
    }

    if (toRestore.length === 1) {
      log.success(`Restored ${toRestore[0]}`);
    } else {
      log.success(`Restored ${toRestore.length} packages`);
    }
  },
});
