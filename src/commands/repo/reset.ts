import { defineCommand } from 'citty';
import { exists } from 'node:fs/promises';
import { join } from 'node:path';

import type { RepoEntry, RepoState } from '../../types';

import { removeRegistryFromNpmrc, removePreCommitHook, removeSkipWorktree, restorePackage } from '../../lib/consumer';
import { log } from '../../lib/log';
import { runInstall } from '../../lib/pm-detect';
import {
  loadRepoByPath,
  deleteRepoByPath,
  getRepoDisplayName,
  loadAllRepos,
  loadOperationalRepos,
  canonicalRepoPath,
} from '../../lib/repo-state';

export default defineCommand({
  meta: { name: 'reset', description: 'Reset repo to original versions' },
  args: {
    name: { type: 'positional', description: 'Repo path', required: false },
    all: { type: 'boolean', description: 'Reset all repos', default: false },
    stale: {
      type: 'boolean',
      description: 'Remove repos whose directories no longer exist',
      default: false,
    },
  },
  async run({ args }) {
    if (args.stale) {
      const allRepos = await loadAllRepos();
      let removed = 0;
      for (const { displayName, state } of allRepos) {
        if (!(await exists(join(state.path, 'package.json')))) {
          await deleteRepoByPath(state.path);
          log.success(`Removed stale repo: ${displayName} (${state.path})`);
          removed++;
        }
      }
      if (removed === 0) {
        log.info('No stale repos found');
      }
      return;
    }

    let targets: RepoEntry[];

    if (args.all) {
      targets = await loadOperationalRepos();
    } else if (args.name) {
      const canonical = await canonicalRepoPath(args.name);
      const state = await loadRepoByPath(canonical);
      if (!state) {
        log.error(`Repo not found at path: ${args.name}`);
        process.exit(1);
      }
      const displayName = await getRepoDisplayName(state.path);
      targets = [{ displayName, state }];
    } else {
      log.error('Specify a repo path, --all, or --stale');
      process.exit(1);
    }

    for (const { displayName, state } of targets) {
      const pkgJsonExists = await exists(join(state.path, 'package.json'));
      if (!pkgJsonExists) {
        log.warn(`Skipping ${displayName}: directory or package.json no longer exists (${state.path})`);
        log.dim(`  Run --stale to remove it`);
        continue;
      }

      log.info(`Resetting ${displayName}...`);
      for (const [pkgName, link] of Object.entries(state.packages)) {
        await restorePackage(state.path, pkgName, link.targets, link.catalogName, link.catalogFormat);
      }

      await removeRegistryFromNpmrc(state.path);
      await removeSkipWorktree(state.path);
      await removePreCommitHook(state.path);

      // Run pm install to sync node_modules after restoring versions
      await runInstall(state.path, { label: displayName });

      await deleteRepoByPath(state.path);
      log.success(`Reset ${displayName}`);
    }
  },
});
