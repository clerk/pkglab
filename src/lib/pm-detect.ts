import { join } from 'node:path';

import { log } from './log';
import { runPm } from './proc';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const LOCKFILES: Record<string, PackageManager> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
};

export async function detectPackageManager(startDir: string): Promise<PackageManager> {
  const entries = Object.entries(LOCKFILES);
  let dir = startDir;

  while (true) {
    const results = await Promise.all(entries.map(([lockfile]) => Bun.file(join(dir, lockfile)).exists()));

    const found: PackageManager[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (results[i]) {
        const pm = entries[i][1];
        if (!found.includes(pm)) {
          found.push(pm);
        }
      }
    }

    if (found.length === 1) {
      return found[0];
    }
    if (found.length > 1) {
      // Multiple lockfiles: prefer pnpm > yarn > bun > npm
      for (const preferred of ['pnpm', 'yarn', 'bun', 'npm'] as const) {
        if (found.includes(preferred)) {
          return preferred;
        }
      }
      return found[0];
    }

    const parent = join(dir, '..');
    if (parent === dir) {
      return 'npm';
    }
    dir = parent;
  }
}

export async function runInstall(repoPath: string, opts?: { label?: string }): Promise<boolean> {
  const pm = await detectPackageManager(repoPath);
  const args: string[] = ['install', '--ignore-scripts'];
  if (pm === 'pnpm' || pm === 'bun') {
    args.push('--prefer-offline');
  }
  log.dim(`  ${pm} ${args.join(' ')}`);
  let result = await runPm(pm, args, { cwd: repoPath });

  // Fallback without --ignore-scripts if the fast path failed
  if (result.exitCode !== 0) {
    const fallbackArgs = args.filter(a => a !== '--ignore-scripts');
    log.dim(`  Retrying: ${pm} ${fallbackArgs.join(' ')}`);
    result = await runPm(pm, fallbackArgs, { cwd: repoPath });
  }

  if (result.exitCode !== 0) {
    const suffix = opts?.label ? ` for ${opts.label}` : '';
    log.warn(`Install failed${suffix}, run '${pm} install' manually`);
    return false;
  }
  return true;
}
