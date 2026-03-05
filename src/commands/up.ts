import { defineCommand } from 'citty';

import { ensureDaemonRunning, getDaemonStatus } from '../lib/daemon';
import { log } from '../lib/log';
import { prefetchUpdateCheck } from '../lib/update-check';

export default defineCommand({
  meta: { name: 'up', description: 'Start the local registry' },
  async run() {
    const existing = await getDaemonStatus();
    if (existing?.running) {
      log.warn(`Already running on port ${existing.port} (PID ${existing.pid})`);
      const { ensureNpmrcForActiveRepos } = await import('../lib/consumer');
      await ensureNpmrcForActiveRepos(existing.port);
      return;
    }

    // Start fetch before interactive prompt so it runs in parallel
    const showUpdate = await prefetchUpdateCheck();

    const info = await ensureDaemonRunning();

    const { deactivateAllRepos, loadOperationalRepos, getActiveRepos } = await import('../lib/repo-state');

    const repos = await loadOperationalRepos();
    const previouslyActive = new Set((await getActiveRepos(repos)).map(r => r.state.path));
    await deactivateAllRepos(repos);
    if (repos.length > 0) {
      // Propagate port to .npmrc in linked repos
      const { addRegistryToNpmrc } = await import('../lib/consumer');
      for (const { displayName, state } of repos) {
        if (Object.keys(state.packages).length > 0) {
          try {
            await addRegistryToNpmrc(state.path, info.port);
          } catch {
            log.warn(`Could not update .npmrc for ${displayName}`);
          }
        }
      }

      const { selectRepos } = await import('../lib/prompt');
      const selected = await selectRepos({
        message: 'Select repos to activate',
        preSelect: previouslyActive,
      });

      if (selected.length > 0) {
        const { activateRepo } = await import('../lib/repo-state');
        for (const { displayName, state } of selected) {
          await activateRepo(state, info.port);
          log.success(`Activated ${displayName}`);
        }
      }
    }

    await showUpdate();
  },
});
