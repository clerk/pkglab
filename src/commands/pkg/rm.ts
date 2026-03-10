import { defineCommand } from 'citty';

import { getPositionalArgs } from '../../lib/args';
import { loadConfig } from '../../lib/config';
import { getDaemonStatus } from '../../lib/daemon';
import { CommandError, DaemonNotRunningError } from '../../lib/errors';
import { log } from '../../lib/log';
import { listPackageNames, removePackage } from '../../lib/registry';

export default defineCommand({
  meta: { name: 'rm', description: 'Remove packages from the local registry' },
  args: {
    name: { type: 'positional', description: 'Package name(s)', required: false },
    all: { type: 'boolean', description: 'Remove all pkglab packages', default: false },
  },
  async run({ args }) {
    const status = await getDaemonStatus();
    if (!status?.running) {
      throw new DaemonNotRunningError();
    }

    const config = await loadConfig();
    const toRemove = args.all ? await listPackageNames(config) : getPositionalArgs(args);

    if (args.all && toRemove.length === 0) {
      log.info('No pkglab packages in the registry');
      return;
    }

    if (toRemove.length === 0) {
      throw new CommandError('Specify package name(s) or use --all');
    }

    const results = await Promise.all(
      toRemove.map(async name => {
        const ok = await removePackage(config, name);
        return { name, ok };
      }),
    );

    for (const { name, ok } of results) {
      if (ok) {
        log.dim(`  Removed ${name}`);
      } else {
        log.warn(`  ${name} not found in registry`);
      }
    }

    const removedResults = results.filter(r => r.ok);
    if (removedResults.length > 0) {
      log.success(`Removed ${removedResults.length} package${removedResults.length !== 1 ? 's' : ''}`);
    }

    if (args.all) {
      const { clearFingerprintState } = await import('../../lib/fingerprint-state');
      await clearFingerprintState();
    } else if (removedResults.length > 0) {
      const { removePackageFromFingerprints } = await import('../../lib/fingerprint-state');
      await Promise.all(removedResults.map(r => removePackageFromFingerprints(r.name)));
    }
  },
});
