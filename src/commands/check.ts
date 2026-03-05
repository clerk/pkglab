import { defineCommand } from 'citty';
import { join, relative } from 'node:path';

import { c } from '../lib/color';
import { CommandError } from '../lib/errors';
import { log } from '../lib/log';
import { run } from '../lib/proc';
import { ispkglabVersion } from '../lib/version';
import { discoverWorkspace } from '../lib/workspace';

export default defineCommand({
  meta: {
    name: 'check',
    description: 'Pre-commit safety check for pkglab artifacts',
  },
  async run() {
    const cwd = process.cwd();
    let issues = 0;

    // Scan root package.json
    issues += await scanPackageJson(cwd, '');

    // Discover workspace sub-packages and scan each
    try {
      const workspace = await discoverWorkspace(cwd);
      for (const pkg of workspace.packages) {
        if (pkg.dir === workspace.root) {
          continue;
        }
        const rel = relative(cwd, pkg.dir);
        issues += await scanPackageJson(pkg.dir, rel);
      }
    } catch {
      // Not a workspace or discovery failed, root-only scan is fine
    }

    // Check git staged files
    try {
      const result = await run(['git', 'diff', '--cached', '--name-only'], { cwd });
      const staged = result.stdout.trim().split('\n').filter(Boolean);

      if (staged.includes('.npmrc')) {
        const showResult = await run(['git', 'show', ':.npmrc'], { cwd });
        if (showResult.stdout.includes('# pkglab-start')) {
          log.line(`  ${c.red('✗')} Staged .npmrc contains pkglab registry markers`);
          issues++;
        }
      }

      // Check all staged package.json files (root and sub-packages)
      const stagedPkgJsons = staged.filter(f => f === 'package.json' || f.endsWith('/package.json'));
      for (const pkgJsonFile of stagedPkgJsons) {
        const showResult = await run(['git', 'show', `:${pkgJsonFile}`], { cwd });
        if (showResult.stdout.includes('0.0.0-pkglab.') || showResult.stdout.includes('0.0.0-pkglab-')) {
          log.line(`  ${c.red('✗')} Staged ${pkgJsonFile} contains pkglab versions`);
          issues++;
        }
      }

      // Check staged lockfiles for localhost registry URLs
      const lockfiles = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml'];
      for (const lockfile of lockfiles) {
        if (!staged.includes(lockfile)) {
          continue;
        }
        try {
          const showResult = await run(['git', 'show', `:${lockfile}`], { cwd });
          const content = showResult.stdout;
          let count = 0;
          let idx = 0;
          while (true) {
            const a = content.indexOf('"http://127.0.0.1:', idx);
            const b = content.indexOf('"http://localhost:', idx);
            if (a === -1 && b === -1) break;
            const next = a === -1 ? b : b === -1 ? a : Math.min(a, b);
            count++;
            idx = next + 1;
          }
          if (count > 0) {
            const formatted = count.toLocaleString();
            log.line(`  ${c.red('✗')} Staged ${lockfile} contains ${formatted} localhost registry URL${count !== 1 ? 's' : ''}`);
            log.line(`    Run: pkglab doctor --lockfile`);
            issues++;
          }
        } catch {
          // Could not read staged lockfile (e.g. binary bun.lockb), skip
        }
      }
    } catch {
      // Not a git repo, skip git checks
    }

    if (issues === 0) {
      log.success('No pkglab artifacts found');
    } else {
      log.error(`Found ${issues} pkglab artifact${issues !== 1 ? 's' : ''} that should not be committed`);
      throw new CommandError(`Found ${issues} pkglab artifact${issues !== 1 ? 's' : ''} that should not be committed`, { logged: true });
    }
  },
});

async function scanPackageJson(dir: string, label: string): Promise<number> {
  const pkgJsonPath = join(dir, 'package.json');
  const pkgFile = Bun.file(pkgJsonPath);
  if (!(await pkgFile.exists())) {
    return 0;
  }

  let issues = 0;
  const prefix = label ? `${label}/` : '';
  const pkgJson = await pkgFile.json();

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkgJson[field]) {
      continue;
    }
    for (const [name, version] of Object.entries(pkgJson[field])) {
      if (typeof version === 'string' && ispkglabVersion(version)) {
        log.line(`  ${c.red('✗')} ${prefix}${field}.${name}: ${version}`);
        issues++;
      }
    }
  }

  // Check catalog fields for pkglab versions
  if (pkgJson.catalog) {
    for (const [name, version] of Object.entries(pkgJson.catalog)) {
      if (typeof version === 'string' && ispkglabVersion(version)) {
        log.line(`  ${c.red('✗')} ${prefix}catalog.${name}: ${version}`);
        issues++;
      }
    }
  }
  if (pkgJson.catalogs) {
    for (const [catName, entries] of Object.entries(pkgJson.catalogs)) {
      if (!entries || typeof entries !== 'object') {
        continue;
      }
      for (const [name, version] of Object.entries(entries as Record<string, string>)) {
        if (typeof version === 'string' && ispkglabVersion(version)) {
          log.line(`  ${c.red('✗')} ${prefix}catalogs.${catName}.${name}: ${version}`);
          issues++;
        }
      }
    }
  }

  return issues;
}
