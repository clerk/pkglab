import { join } from 'node:path';

import { c } from './color';
import { log } from './log';
import { paths } from './paths';
import { getVersion } from './version';

const CHECK_FILE = join(paths.home, 'update-check.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheData {
  latestVersion: string;
  checkedAt: number;
}

async function readCache(): Promise<CacheData | null> {
  try {
    const file = Bun.file(CHECK_FILE);
    if (!(await file.exists())) {
      return null;
    }
    return (await file.json()) as CacheData;
  } catch {
    return null;
  }
}

async function writeCache(latest: string): Promise<void> {
  const data: CacheData = { latestVersion: latest, checkedAt: Date.now() };
  await Bun.write(CHECK_FILE, JSON.stringify(data));
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/pkglab/latest', {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function parseVersion(v: string) {
  return v.replace(/^v/, '').split('.').map(Number);
}

function isNewer(latest: string, current: string): boolean {
  const [lMaj, lMin, lPat] = parseVersion(latest);
  const [cMaj, cMin, cPat] = parseVersion(current);
  if (lMaj !== cMaj) {
    return lMaj > cMaj;
  }
  if (lMin !== cMin) {
    return lMin > cMin;
  }
  return lPat > cPat;
}

// Call early so the fetch runs in the background while the user interacts.
export async function prefetchUpdateCheck(): Promise<() => Promise<void>> {
  const current = await getVersion();
  if (current === '0.0.0') {
    return async () => {};
  }

  const cached = await readCache();
  const isFresh = cached && Date.now() - cached.checkedAt < CACHE_TTL_MS;

  // Use cached result if fresh, otherwise kick off a background fetch
  const fetchPromise = isFresh ? null : fetchLatestVersion();

  return async () => {
    try {
      const latest = fetchPromise ? await fetchPromise : cached?.latestVersion;
      if (latest) {
        if (fetchPromise) {
          await writeCache(latest);
        }
        if (isNewer(latest, current)) {
          printBanner(current, latest);
        }
      }
    } catch {
      // never block exit
    }
  };
}

function printBanner(current: string, latest: string): void {
  log.line('');
  log.line(`  ${c.yellow('Update available')} ${c.dim(current)} → ${c.green(latest)}`);
  log.line(`  Run ${c.cyan('bun install -g pkglab')} to update`);
  log.line('');
}
