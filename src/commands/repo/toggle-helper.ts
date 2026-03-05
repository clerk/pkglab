import type { RepoState } from '../../types';

import { getPositionalArgs } from '../../lib/args';
import { CommandError } from '../../lib/errors';
import { log } from '../../lib/log';
import {
  loadOperationalRepos,
  loadRepoByPath,
  getRepoDisplayName,
  canonicalRepoPath,
} from '../../lib/repo-state';

interface ToggleOptions {
  /** "activate" or "deactivate" */
  verb: string;
  /** Past tense for success messages, e.g. "Activated" */
  pastTense: string;
  /** Filter predicate: which repos to skip in --all mode (already in desired state) */
  shouldSkip: (state: RepoState) => boolean;
  /** Filter for interactive picker: which repos to show */
  pickerFilter: (state: RepoState) => boolean;
  /** Message when all repos already match desired state */
  allDoneMessage: string;
  /** Message for empty interactive picker */
  pickerEmptyMessage: string;
  /** Apply the state change to a single repo */
  apply: (state: RepoState) => Promise<void>;
}

export async function runToggle(
  args: { name?: string; all?: boolean; _?: string[] },
  opts: ToggleOptions,
) {
  const pathArg = args.name as string | undefined;

  const applyAndLog = async (state: RepoState) => {
    await opts.apply(state);
    const displayName = await getRepoDisplayName(state.path);
    log.success(`${opts.pastTense} ${displayName}`);
  };

  const applyByPath = async (repoPath: string) => {
    const canonical = await canonicalRepoPath(repoPath);
    const state = await loadRepoByPath(canonical);
    if (!state) {
      throw new CommandError(`Repo not found at path: ${repoPath}`);
    }
    await applyAndLog(state);
  };

  // --all: toggle every known repo
  if (args.all) {
    const repos = await loadOperationalRepos();
    if (repos.length === 0) {
      log.info('No repos registered');
      return;
    }

    let count = 0;
    for (const { state } of repos) {
      if (opts.shouldSkip(state)) {
        continue;
      }
      await applyAndLog(state);
      count++;
    }

    if (count === 0) {
      log.info(opts.allDoneMessage);
    }
    return;
  }

  // Positional args: toggle specific repos by path
  const paths = getPositionalArgs(args);
  if (pathArg) {
    paths.unshift(pathArg);
  }

  if (paths.length > 0) {
    for (const p of paths) {
      await applyByPath(p);
    }
    return;
  }

  // No args: interactive picker
  const { selectRepos } = await import('../../lib/prompt');
  const selected = await selectRepos({
    message: `Select repos to ${opts.verb}`,
    filter: opts.pickerFilter,
    emptyMessage: opts.pickerEmptyMessage,
  });

  if (selected.length === 0) {
    return;
  }

  for (const { state } of selected) {
    await applyAndLog(state);
  }
}
