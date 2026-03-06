import { defineCommand } from 'citty';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { c } from '../lib/color';
import { loadConfig } from '../lib/config';
import { MARKER_START, addRegistryToNpmrc } from '../lib/consumer';
import { getDaemonStatus } from '../lib/daemon';
import { inspectFingerprints } from '../lib/fingerprint-state';
import { log } from '../lib/log';
import { paths } from '../lib/paths';
import { BACKUP_SUFFIX } from '../lib/publisher';
import { loadOperationalRepos } from '../lib/repo-state';

export default defineCommand({
  meta: { name: 'doctor', description: 'Health check for pkglab environment' },
  args: {
    lockfile: {
      type: 'boolean',
      description: 'Sanitize bun.lock files in consumer repos by removing localhost URLs',
      default: false,
    },
    prune: {
      type: 'boolean',
      description: 'Remove stale fingerprint files for workspaces that no longer exist on disk',
      default: false,
    },
  },
  async run({ args }) {
    let issues = 0;

    // Check Bun
    const bunVersion = Bun.version;
    log.line(`  ${c.green('✓')} Bun ${bunVersion}`);

    // Check pkglab dirs
    for (const dir of [paths.home, paths.reposDir, paths.registryDir]) {
      try {
        await stat(dir);
        log.line(`  ${c.green('✓')} ${dir}`);
      } catch {
        log.line(`  ${c.red('✗')} ${dir} missing`);
        issues++;
      }
    }

    // Check daemon
    const config = await loadConfig();
    const status = await getDaemonStatus();
    if (status?.running) {
      log.line(`  ${c.green('✓')} Registry running (PID ${status.pid})`);

      // Ping registry
      try {
        const resp = await fetch(`http://127.0.0.1:${config.port}/-/ping`);
        if (resp.ok) {
          log.line(`  ${c.green('✓')} Registry responding on port ${config.port}`);
        } else {
          log.line(`  ${c.red('✗')} Registry not responding (HTTP ${resp.status})`);
          issues++;
        }
      } catch {
        log.line(`  ${c.red('✗')} Registry not responding`);
        issues++;
      }
    } else {
      log.line(`  ${c.yellow('!')} Registry not running`);
    }

    // Check .npmrc and skip-worktree on linked repos
    const repos = await loadOperationalRepos();
    for (const { displayName, state } of repos) {
      if (Object.keys(state.packages).length === 0) {
        continue;
      }

      // Check .npmrc has pkglab registry block
      try {
        const npmrcFile = Bun.file(join(state.path, '.npmrc'));
        const exists = await npmrcFile.exists();
        const hasBlock = exists && (await npmrcFile.text()).includes(MARKER_START);

        if (hasBlock) {
          log.line(`  ${c.green('✓')} ${displayName}: .npmrc OK`);
        } else {
          log.line(
            `  ${c.yellow('!')} ${displayName}: .npmrc ${exists ? 'missing registry block' : 'missing'}, repairing...`,
          );
          await addRegistryToNpmrc(state.path, config.port);
          log.line(`  ${c.green('✓')} ${displayName}: .npmrc repaired`);
        }
      } catch (err) {
        log.line(
          `  ${c.red('✗')} ${displayName}: could not check .npmrc (${err instanceof Error ? err.message : String(err)})`,
        );
        issues++;
      }

    }

    // Dirty state: daemon not running but repos have active pkglab packages
    if (!status?.running) {
      const dirtyRepos = repos.filter(r => Object.keys(r.state.packages).length > 0);
      if (dirtyRepos.length > 0) {
        log.line(
          `  ${c.yellow('!')} Dirty state: daemon not running but ${dirtyRepos.length} repo${dirtyRepos.length !== 1 ? 's' : ''} ha${dirtyRepos.length !== 1 ? 've' : 's'} active pkglab packages`,
        );
        log.line(`    Run: ${c.cyan('pkglab restore --all')} (in each consumer repo)`);
        log.line(`    Or:  ${c.cyan('pkglab down --force')} (to clear state without restoring)`);
        issues++;
      }
    }

    // --lockfile: sanitize bun.lock files in consumer repos
    if (args.lockfile) {
      const localhostUrlRe = /"http:\/\/(?:127\.0\.0\.1|localhost):[^"]*"/g;
      for (const { displayName, state } of repos) {
        if (Object.keys(state.packages).length === 0) {
          continue;
        }
        const lockPath = join(state.path, 'bun.lock');
        const lockFile = Bun.file(lockPath);
        if (!(await lockFile.exists())) {
          continue;
        }
        const content = await lockFile.text();
        const matches = content.match(localhostUrlRe);
        if (!matches || matches.length === 0) {
          log.line(`  ${c.green('✓')} ${displayName}: bun.lock clean`);
          continue;
        }
        const sanitized = content.replace(localhostUrlRe, '""');
        await Bun.write(lockPath, sanitized);
        log.line(`  ${c.green('✓')} ${displayName}: sanitized ${matches.length} localhost URL${matches.length !== 1 ? 's' : ''} in bun.lock`);
      }
    }

    // Check for leftover publish backups in cwd
    const glob = new Bun.Glob(`**/package.json${BACKUP_SUFFIX}`);
    const backups: string[] = [];
    for await (const match of glob.scan({ cwd: process.cwd(), absolute: true })) {
      if (match.includes('node_modules/')) {
        continue;
      }
      backups.push(match);
    }
    if (backups.length > 0) {
      log.line(`  ${c.red('✗')} Found ${backups.length} leftover publish backup(s):`);
      for (const b of backups) {
        log.line(`      ${b}`);
      }
      log.line(`    These are original package.json files from a crashed publish.`);
      log.line(`    Run ${c.cyan('pkglab pub')} again to auto-recover, or rename them back manually.`);
      issues += backups.length;
    }

    // Check fingerprint files
    const fp = await inspectFingerprints({ prune: args.prune });
    if (fp.total > 0) {
      if (fp.stale === 0 && fp.legacy === 0) {
        log.line(`  ${c.green('✓')} Fingerprints: ${fp.total} file${fp.total !== 1 ? 's' : ''}, all clean`);
      } else {
        if (fp.legacy > 0) {
          log.line(`  ${c.yellow('!')} Fingerprints: ${fp.legacy} legacy file${fp.legacy !== 1 ? 's' : ''} (missing metadata)`);
        }
        if (fp.stale > 0 && !args.prune) {
          log.line(
            `  ${c.yellow('!')} Fingerprints: ${fp.stale} stale file${fp.stale !== 1 ? 's' : ''} (workspace no longer exists)`,
          );
          log.line(`    Run: ${c.cyan('pkglab doctor --prune')} to remove them`);
        }
        if (fp.pruned > 0) {
          log.line(`  ${c.green('✓')} Fingerprints: pruned ${fp.pruned} stale file${fp.pruned !== 1 ? 's' : ''}`);
        }
      }
    }

    if (issues === 0) {
      log.success('All checks passed');
    } else {
      log.warn(`${issues} issue${issues !== 1 ? 's' : ''} found`);
    }
  },
});
