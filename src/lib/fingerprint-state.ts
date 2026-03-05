import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

import type { FileStat, PackageFingerprint } from './fingerprint';
import { atomicWrite } from './fs';
import { paths } from './paths';

interface FingerprintEntry {
  hash: string;
  version: string;
  fileStats?: FileStat[];
}

// Per-workspace file format: { "@scope/pkg": { "untagged": { hash, version }, "feat1": { hash, version } } }
type PerWorkspaceFile = Record<string, Record<string, FingerprintEntry>>;

// Old monolithic format for migration
type LegacyFingerprintFile = Record<string, Record<string, Record<string, FingerprintEntry>>>;

export type FingerprintMap = Record<string, FingerprintEntry>;

// Old path, kept for migration only
const LEGACY_FINGERPRINT_PATH = join(paths.home, 'fingerprints.json');

export function fingerprintPath(workspaceRoot: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
  return join(paths.fingerprintsDir, `${hash}.json`);
}

function tagKey(tag: string | null): string {
  return tag ?? '__untagged__';
}

async function migrateFromLegacy(workspaceRoot: string): Promise<PerWorkspaceFile | null> {
  const legacyFile = Bun.file(LEGACY_FINGERPRINT_PATH);
  if (!(await legacyFile.exists())) {
    return null;
  }

  try {
    const data: LegacyFingerprintFile = await legacyFile.json();
    const workspace = data[workspaceRoot];
    if (!workspace) {
      return null;
    }

    // Write migrated data to per-workspace file
    await mkdir(paths.fingerprintsDir, { recursive: true });
    const dest = fingerprintPath(workspaceRoot);
    await atomicWrite(dest, JSON.stringify(workspace, null, 2) + '\n');
    return workspace;
  } catch {
    return null;
  }
}

export async function loadFingerprintState(workspaceRoot: string, tag: string | null): Promise<FingerprintMap> {
  const filePath = fingerprintPath(workspaceRoot);
  const file = Bun.file(filePath);

  let data: PerWorkspaceFile | null = null;

  if (await file.exists()) {
    try {
      data = await file.json();
    } catch {
      // Corrupted file, treat as empty
      data = null;
    }
  } else {
    // Try migrating from legacy monolithic file
    data = await migrateFromLegacy(workspaceRoot);
  }

  if (!data) {
    return {};
  }

  const key = tagKey(tag);
  const result: FingerprintMap = {};
  for (const [pkgName, tags] of Object.entries(data)) {
    const entry = tags[key];
    if (entry) {
      result[pkgName] = entry;
    }
  }
  return result;
}

/**
 * Convert loaded FingerprintMap to Map<string, PackageFingerprint> for passing
 * to fingerprintPackages as previous state for mtime gating.
 */
export function toPackageFingerprints(state: FingerprintMap): Map<string, PackageFingerprint> {
  const result = new Map<string, PackageFingerprint>();
  for (const [name, entry] of Object.entries(state)) {
    result.set(name, {
      hash: entry.hash,
      fileCount: 0,
      fileStats: entry.fileStats,
    });
  }
  return result;
}

export async function saveFingerprintState(
  workspaceRoot: string,
  tag: string | null,
  entries: { name: string; hash: string; version: string; fileStats?: FileStat[] }[],
): Promise<void> {
  const filePath = fingerprintPath(workspaceRoot);
  const file = Bun.file(filePath);
  let data: PerWorkspaceFile = {};

  if (await file.exists()) {
    try {
      data = await file.json();
    } catch {
      // Corrupted, start fresh
      data = {};
    }
  }

  const key = tagKey(tag);
  for (const entry of entries) {
    if (!data[entry.name]) {
      data[entry.name] = {};
    }
    data[entry.name][key] = {
      hash: entry.hash,
      version: entry.version,
      fileStats: entry.fileStats,
    };
  }

  await mkdir(paths.fingerprintsDir, { recursive: true });
  await atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n');
}

export async function clearFingerprintState(): Promise<void> {
  // Remove the per-workspace fingerprints directory
  await rm(paths.fingerprintsDir, { recursive: true, force: true });
  // Also remove the legacy monolithic file if it exists
  const legacyFile = Bun.file(LEGACY_FINGERPRINT_PATH);
  if (await legacyFile.exists()) {
    await rm(LEGACY_FINGERPRINT_PATH);
  }
}
