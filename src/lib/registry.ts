import type { pkglabConfig } from '../types';

export function registryUrl(config: pkglabConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

// ---------------------------------------------------------------------------
// HTTP index helpers
// ---------------------------------------------------------------------------

let cachedIndex: {
  packages: Record<string, { rev: string; 'dist-tags': Record<string, string>; versions: string[] }>;
} | null = null;

async function fetchIndex(config: pkglabConfig): Promise<typeof cachedIndex> {
  if (cachedIndex) return cachedIndex;
  const resp = await fetch(`${registryUrl(config)}/-/pkglab/index`);
  if (!resp.ok) throw new Error(`Failed to fetch index: ${resp.status}`);
  cachedIndex = await resp.json();
  return cachedIndex;
}

export function invalidateIndexCache(): void {
  cachedIndex = null;
}

export async function listPackageNames(config: pkglabConfig): Promise<string[]> {
  const index = await fetchIndex(config);
  return Object.keys(index!.packages);
}

export async function listAllPackages(config: pkglabConfig): Promise<Array<{ name: string; versions: string[] }>> {
  const index = await fetchIndex(config);
  return Object.entries(index!.packages).map(([name, data]) => ({
    name,
    versions: data.versions,
  }));
}

export async function getDistTags(name: string, config: pkglabConfig): Promise<Record<string, string>> {
  const index = await fetchIndex(config);
  const pkg = index!.packages[name];
  if (!pkg?.['dist-tags']) return {};
  return { ...pkg['dist-tags'] };
}

// ---------------------------------------------------------------------------
// HTTP mutations
// ---------------------------------------------------------------------------

export async function setDistTag(config: pkglabConfig, name: string, version: string, tag: string): Promise<void> {
  const url = `${registryUrl(config)}/-/package/${encodeURIComponent(name)}/dist-tags/${encodeURIComponent(tag)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer pkglab-local',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(version),
  });
  if (!resp.ok) {
    throw new Error(`Failed to set dist-tag ${tag} on ${name}: ${resp.status}`);
  }
  invalidateIndexCache();
}

export async function unpublishVersions(
  config: pkglabConfig,
  name: string,
  versions: string[],
): Promise<{ removed: string[]; failed: string[] }> {
  if (versions.length === 0) {
    return { removed: [], failed: [] };
  }

  const url = registryUrl(config);
  const pkgUrl = `${url}/${encodeURIComponent(name)}`;
  const headers = { Authorization: 'Bearer pkglab-local' };

  const resp = await fetch(pkgUrl, { headers });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${name}: ${resp.status}`);
  }

  const doc = await resp.json();
  const removeSet = new Set(versions);
  const removed: string[] = [];

  for (const v of versions) {
    if (!doc.versions?.[v]) {
      continue;
    }
    delete doc.versions[v];
    if (doc.time) {
      delete doc.time[v];
    }
    removed.push(v);
  }

  // Clean up dist-tags pointing to removed versions
  if (doc['dist-tags']) {
    for (const [tag, v] of Object.entries(doc['dist-tags'])) {
      if (removeSet.has(v as string)) {
        delete doc['dist-tags'][tag];
      }
    }
  }

  if (removed.length === 0) {
    return { removed: [], failed: [] };
  }

  const rev = doc._rev || '0-0';
  let putResp = await fetch(`${pkgUrl}/-rev/${rev}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });

  // Retry on 409 conflict (revision mismatch)
  const MAX_RETRIES = 3;
  for (let retry = 0; !putResp.ok && putResp.status === 409 && retry < MAX_RETRIES; retry++) {
    invalidateIndexCache();
    // Refetch latest doc
    const refetchResp = await fetch(pkgUrl, { headers });
    if (!refetchResp.ok) break;
    const freshDoc = await refetchResp.json();
    // Reapply mutations
    const freshRemoved: string[] = [];
    for (const v of versions) {
      if (!freshDoc.versions?.[v]) continue;
      delete freshDoc.versions[v];
      if (freshDoc.time) delete freshDoc.time[v];
      freshRemoved.push(v);
    }
    if (freshDoc['dist-tags']) {
      for (const [tag, v] of Object.entries(freshDoc['dist-tags'])) {
        if (removeSet.has(v as string)) delete freshDoc['dist-tags'][tag];
      }
    }
    if (freshRemoved.length === 0) break;
    const freshRev = freshDoc._rev || '0-0';
    putResp = await fetch(`${pkgUrl}/-rev/${freshRev}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(freshDoc),
    });
    if (putResp.ok) {
      removed.length = 0;
      removed.push(...freshRemoved);
    }
  }

  if (!putResp.ok) {
    return { removed: [], failed: versions };
  }

  invalidateIndexCache();
  return { removed, failed: versions.filter(v => !removed.includes(v)) };
}

export async function removePackage(config: pkglabConfig, name: string): Promise<boolean> {
  const url = registryUrl(config);
  const pkgUrl = `${url}/${encodeURIComponent(name)}`;
  const headers = { Authorization: 'Bearer pkglab-local' };

  // Get the revision needed for DELETE
  const resp = await fetch(pkgUrl, { headers });
  if (!resp.ok) {
    return false;
  }
  const doc = await resp.json();
  const rev = doc._rev || '0-0';

  // Delete from registry API
  const delResp = await fetch(`${pkgUrl}/-rev/${rev}`, {
    method: 'DELETE',
    headers,
  });
  invalidateIndexCache();

  return delResp.ok;
}
