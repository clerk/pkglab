import { defineCommand } from 'citty';
import { rm } from 'node:fs/promises';

import { getDaemonStatus, stopDaemon } from '../lib/daemon';
import { CommandError } from '../lib/errors';
import { clearFingerprintState } from '../lib/fingerprint-state';
import { log } from '../lib/log';
import { paths } from '../lib/paths';

export default defineCommand({
  meta: { name: 'reset', description: 'Reset pkglab state' },
  args: {
    hard: {
      type: 'boolean',
      description: 'Wipe all pkglab data and registry storage',
      default: false,
    },
    fingerprints: {
      type: 'boolean',
      description: 'Clear fingerprint cache (forces full republish on next pub)',
      default: false,
    },
  },
  async run({ args }) {
    if (args.fingerprints) {
      await clearFingerprintState();
      log.success('Fingerprint cache cleared. Next pub will republish all packages.');
      return;
    }

    if (!args.hard) {
      throw new CommandError('Use --hard to confirm: pkglab reset --hard');
    }

    const status = await getDaemonStatus();
    if (status?.running) {
      await stopDaemon();
      log.info('Stopped registry');
    }

    await rm(paths.home, { recursive: true, force: true });
    log.success('Reset complete. All pkglab data wiped.');
  },
});
