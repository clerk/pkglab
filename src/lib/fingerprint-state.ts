import { join } from 'node:path';

import type { FileStat, PackageFingerprint } from './fingerprint';
import { atomicWrite } from './fs';
import { paths } from './paths';

interface FingerprintEntry {
  hash: string;
  version: string;
  fileStats?: FileStat[];
}

// Per-workspace, per-package, per-tag state
// { "/path/to/workspace": { "@scope/pkg": { "untagged": { hash, version }, "feat1": { hash, version } } } }
type FingerprintFile = Record<string, Record<string, Record<string, FingerprintEntry>>>;

export type FingerprintMap = Record<string, FingerprintEntry>;

const FINGERPRINT_PATH = join(paths.home, 'fingerprints.json');

function tagKey(tag: string | null): string {
  return tag ?? '__untagged__';
}

export async function loadFingerprintState(workspaceRoot: string, tag: string | null): Promise<FingerprintMap> {
  const file = Bun.file(FINGERPRINT_PATH);
  if (!(await file.exists())) {
    return {};
  }

  try {
    const data: FingerprintFile = await file.json();
    const workspace = data[workspaceRoot];
    if (!workspace) {
      return {};
    }

    const key = tagKey(tag);
    const result: FingerprintMap = {};
    for (const [pkgName, tags] of Object.entries(workspace)) {
      const entry = tags[key];
      if (entry) {
        result[pkgName] = entry;
      }
    }
    return result;
  } catch {
    // Corrupted file, treat as empty
    return {};
  }
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
  const file = Bun.file(FINGERPRINT_PATH);
  let data: FingerprintFile = {};

  if (await file.exists()) {
    try {
      data = await file.json();
    } catch {
      // Corrupted, start fresh
      data = {};
    }
  }

  if (!data[workspaceRoot]) {
    data[workspaceRoot] = {};
  }

  const key = tagKey(tag);
  for (const entry of entries) {
    if (!data[workspaceRoot][entry.name]) {
      data[workspaceRoot][entry.name] = {};
    }
    data[workspaceRoot][entry.name][key] = {
      hash: entry.hash,
      version: entry.version,
      fileStats: entry.fileStats,
    };
  }

  await atomicWrite(FINGERPRINT_PATH, JSON.stringify(data, null, 2) + '\n');
}

export async function clearFingerprintState(): Promise<void> {
  const file = Bun.file(FINGERPRINT_PATH);
  if (await file.exists()) {
    const { rm } = await import('node:fs/promises');
    await rm(FINGERPRINT_PATH);
  }
}
