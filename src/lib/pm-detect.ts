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

const PACKAGE_MANAGERS: readonly string[] = ['npm', 'pnpm', 'yarn', 'bun'];

// Reads the corepack `packageManager` field (e.g. "pnpm@10.1.0+sha512..."). Returns null if absent or unknown.
async function readPackageManagerField(dir: string): Promise<PackageManager | null> {
  try {
    const pkg = await Bun.file(join(dir, 'package.json')).json();
    const name = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
    return PACKAGE_MANAGERS.includes(name) ? (name as PackageManager) : null;
  } catch {
    return null;
  }
}

/**
 * Walk up from startDir. At each level, the package.json `packageManager` field
 * wins over lockfiles in the same dir. Nearest declaration wins. Defaults to npm.
 */
export async function detectPackageManager(startDir: string): Promise<PackageManager> {
  const entries = Object.entries(LOCKFILES);
  let dir = startDir;

  while (true) {
    const declared = await readPackageManagerField(dir);
    if (declared) {
      return declared;
    }

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

/** Install flag that skips lifecycle scripts. Yarn 2+ rejects --ignore-scripts and uses --mode=skip-build. */
export async function ignoreScriptsArgs(pm: PackageManager, cwd: string): Promise<string[]> {
  if (pm !== 'yarn') {
    return ['--ignore-scripts'];
  }
  const { stdout } = await runPm('yarn', ['--version'], { cwd });
  return Number.parseInt(stdout.trim(), 10) >= 2 ? ['--mode=skip-build'] : ['--ignore-scripts'];
}

export async function runInstall(repoPath: string, opts?: { label?: string }): Promise<boolean> {
  const pm = await detectPackageManager(repoPath);
  const args: string[] = ['install', ...(await ignoreScriptsArgs(pm, repoPath))];
  if (pm === 'pnpm' || pm === 'bun') {
    args.push('--prefer-offline');
  }
  log.dim(`  ${pm} ${args.join(' ')}`);
  const result = await runPm(pm, args, { cwd: repoPath });

  if (result.exitCode !== 0) {
    const output = (result.stderr || result.stdout).trim();
    if (output) {
      log.dim(output.slice(0, 1000));
    }
    const suffix = opts?.label ? ` for ${opts.label}` : '';
    log.warn(`Install failed${suffix}, run '${pm} install' manually`);
    return false;
  }
  return true;
}
