import { dirname, join } from 'node:path';

import { atomicWrite } from './fs';
import { log } from './log';
import { run } from './proc';

export interface LockfilePatchEntry {
  name: string;
  oldVersion: string;
  newVersion: string;
  integrity: string;
}

// Replace all occurrences of `search` with `replacement` in `source`.
// Uses split/join instead of regex to avoid special character escaping issues
// and for better performance on large strings.
function replaceAll(source: string, search: string, replacement: string): string {
  return source.split(search).join(replacement);
}

// Given a package name and version, find the `resolution: {integrity: ...}` line
// in the packages section and replace the integrity hash. The package key looks like:
//   '@scope/name@0.0.0-pkglab.1771180121787':
// and within the next few lines:
//   resolution: {integrity: sha512-abc123...==}
function replaceIntegrity(content: string, name: string, version: string, newIntegrity: string): string {
  const packageKey = `'${name}@${version}':`;
  const keyIndex = content.indexOf(packageKey);
  if (keyIndex === -1) {
    // Package key not found in lockfile, skip integrity replacement
    return content;
  }

  // Search within a reasonable window after the package key for the integrity field
  const searchWindow = 500;
  const windowStart = keyIndex + packageKey.length;
  const windowEnd = Math.min(windowStart + searchWindow, content.length);
  const window = content.slice(windowStart, windowEnd);

  const integrityPrefix = 'resolution: {integrity: ';
  const integrityStart = window.indexOf(integrityPrefix);
  if (integrityStart === -1) {
    return content;
  }

  const hashStart = integrityStart + integrityPrefix.length;
  const hashEnd = window.indexOf('}', hashStart);
  if (hashEnd === -1) {
    return content;
  }

  // Reconstruct the content with the new integrity hash
  const absoluteHashStart = windowStart + hashStart;
  const absoluteHashEnd = windowStart + hashEnd;
  return content.slice(0, absoluteHashStart) + newIntegrity + content.slice(absoluteHashEnd);
}

/**
 * Patch pnpm-lock.yaml: replace old pkglab versions with new ones,
 * update integrity hashes, then run pnpm install --frozen-lockfile.
 * Returns true on success. On failure, restores original lockfile and returns false.
 */
export async function patchPnpmLockfile(
  lockfileDir: string,
  entries: LockfilePatchEntry[],
): Promise<boolean> {
  // Walk upward to find pnpm-lock.yaml (lives at the workspace root,
  // but lockfileDir may be a sub-package within the monorepo)
  let lockfilePath: string | undefined;
  let dir = lockfileDir;
  while (true) {
    const candidate = join(dir, 'pnpm-lock.yaml');
    if (await Bun.file(candidate).exists()) {
      lockfilePath = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!lockfilePath) {
    return false;
  }

  const original = await Bun.file(lockfilePath).text();
  const lockfileRoot = dirname(lockfilePath);
  let patched = original;

  // Phase 1: replace version strings globally (covers importers, packages, snapshots).
  // Deduplicate since all entries typically share the same version timestamp.
  const replacedVersions = new Set<string>();
  for (const entry of entries) {
    if (!replacedVersions.has(entry.oldVersion)) {
      replacedVersions.add(entry.oldVersion);
      patched = replaceAll(patched, entry.oldVersion, entry.newVersion);
    }
  }

  // Phase 2: replace integrity hashes in the packages section
  for (const entry of entries) {
    if (entry.integrity) {
      patched = replaceIntegrity(patched, entry.name, entry.newVersion, entry.integrity);
    }
  }

  // Validate: no old versions should remain
  for (const entry of entries) {
    if (patched.includes(entry.oldVersion)) {
      log.warn(`lockfile patch: old version ${entry.oldVersion} still present after patching`);
      return false;
    }
  }

  // Write the patched lockfile
  await atomicWrite(lockfilePath, patched);

  // Run pnpm install with frozen lockfile to apply without resolution
  const result = await run(
    ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline'],
    { cwd: lockfileRoot },
  );

  if (result.exitCode === 0) {
    return true;
  }

  // Install failed, restore original lockfile
  const errOutput = (result.stderr || result.stdout).trim();
  if (errOutput) {
    log.dim(`lockfile patch: ${errOutput.slice(0, 500)}`);
  }
  log.dim(`lockfile patch: frozen install failed (exit ${result.exitCode}), restoring original`);
  await atomicWrite(lockfilePath, original);
  return false;
}

/**
 * Fetch integrity hashes from the local registry for the given packages.
 * Queries each package's packument and reads versions[version].dist.integrity.
 */
export async function fetchIntegrityHashes(
  port: number,
  packages: Array<{ name: string; version: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  const fetches = packages.map(async (pkg) => {
    const encodedName = encodeURIComponent(pkg.name).replace('%40', '@');
    const url = `http://127.0.0.1:${port}/${encodedName}`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        log.dim(`lockfile patch: registry returned ${response.status} for ${pkg.name}`);
        return;
      }

      const packument = (await response.json()) as Record<string, any>;
      const integrity = packument?.versions?.[pkg.version]?.dist?.integrity;

      if (typeof integrity === 'string') {
        result.set(pkg.name, integrity);
      } else {
        log.dim(`lockfile patch: no integrity found for ${pkg.name}@${pkg.version}`);
      }
    } catch {
      log.dim(`lockfile patch: failed to fetch packument for ${pkg.name}`);
    }
  });

  await Promise.all(fetches);
  return result;
}
