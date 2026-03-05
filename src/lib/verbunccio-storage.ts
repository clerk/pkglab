import { mkdir, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { log } from './log';
import { paths } from './paths';
import { ispkglabVersion } from './version';

export interface PackumentDoc {
  _id: string;
  _rev: string;
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, any>;
  time?: Record<string, string>;
  _attachments?: Record<string, any>;
  [key: string]: any;
}

export interface PkglabIndexEntry {
  rev: string;
  'dist-tags': Record<string, string>;
  versions: string[];
}

export interface PkglabIndex {
  packages: Record<string, PkglabIndexEntry>;
}

interface MergedCacheEntry {
  json: string;
  fetchedAt: number;
}

class VerbunccioStorage {
  private packuments: Map<string, PackumentDoc> = new Map();
  private fullJsonCache: Map<string, string> = new Map();
  private mergedPackumentCache: Map<string, MergedCacheEntry> = new Map();
  private indexCache: string | null = null;
  private locks: Map<string, Promise<void>> = new Map();

  async loadAll(): Promise<void> {
    const storageDir = paths.registryStorage;
    let entries: string[];
    try {
      entries = await readdir(storageDir);
    } catch {
      // Storage directory doesn't exist yet, nothing to load
      return;
    }

    let loaded = 0;

    for (const entry of entries) {
      if (entry.startsWith('@')) {
        // Scoped packages: read one level deeper
        const scopeDir = join(storageDir, entry);
        let scopeEntries: string[];
        try {
          scopeEntries = await readdir(scopeDir);
        } catch {
          continue;
        }
        for (const sub of scopeEntries) {
          if (sub.endsWith('.tmp')) {
            await this.cleanTmp(join(scopeDir, sub));
            continue;
          }
          const pkgDir = join(scopeDir, sub);
          const count = await this.loadPackageDir(pkgDir, `${entry}/${sub}`);
          loaded += count;
        }
      } else {
        if (entry.endsWith('.tmp')) {
          await this.cleanTmp(join(storageDir, entry));
          continue;
        }
        const pkgDir = join(storageDir, entry);
        const count = await this.loadPackageDir(pkgDir, entry);
        loaded += count;
      }
    }

    if (loaded > 0) {
      log.dim(`loaded ${loaded} package(s) from storage`);
    }
  }

  private async loadPackageDir(dir: string, name: string): Promise<number> {
    // Clean up any tmp files first (before checking for package.json)
    try {
      const dirEntries = await readdir(dir);
      for (const e of dirEntries) {
        if (e.endsWith('.tmp')) {
          await this.cleanTmp(join(dir, e));
        }
      }
    } catch {
      // ignore readdir errors
    }

    const pkgJsonPath = join(dir, 'package.json');
    const file = Bun.file(pkgJsonPath);
    if (!(await file.exists())) {
      return 0;
    }

    try {
      const doc = (await file.json()) as PackumentDoc;
      this.packuments.set(name, doc);
      return 1;
    } catch {
      log.warn(`failed to parse ${pkgJsonPath}, skipping`);
      return 0;
    }
  }

  private async cleanTmp(filepath: string): Promise<void> {
    try {
      await unlink(filepath);
    } catch {
      // ignore, best effort
    }
  }

  hasPackage(name: string): boolean {
    return this.packuments.has(name);
  }

  getPackument(name: string): PackumentDoc | undefined {
    return this.packuments.get(name);
  }

  getFullJson(name: string): string | undefined {
    const cached = this.fullJsonCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const doc = this.packuments.get(name);
    if (!doc) {
      return undefined;
    }
    const json = JSON.stringify(doc);
    this.fullJsonCache.set(name, json);
    return json;
  }

  async savePackument(name: string, doc: PackumentDoc): Promise<void> {
    // Strip _attachments[*].data before writing to disk (saves space)
    const toWrite = { ...doc };
    if (toWrite._attachments) {
      const stripped: Record<string, any> = {};
      for (const [filename, meta] of Object.entries(toWrite._attachments)) {
        const { data: _data, ...rest } = meta as Record<string, any>;
        stripped[filename] = rest;
      }
      toWrite._attachments = stripped;
    }

    const dir = this.packageDir(name);
    await mkdir(dir, { recursive: true });

    const finalPath = join(dir, 'package.json');
    const tmpPath = `${finalPath}.tmp`;

    await Bun.write(tmpPath, JSON.stringify(toWrite, null, 2));
    await rename(tmpPath, finalPath);

    // Update in-memory state only after disk commit succeeds
    this.packuments.set(name, doc);
    this.invalidateCache(name);
  }

  async saveTarball(name: string, filename: string, data: Buffer): Promise<void> {
    const dir = this.packageDir(name);
    await mkdir(dir, { recursive: true });

    const finalPath = join(dir, filename);
    const tmpPath = `${finalPath}.tmp`;

    await Bun.write(tmpPath, data);
    await rename(tmpPath, finalPath);
  }

  getTarballPath(name: string, filename: string): string {
    return join(this.packageDir(name), filename);
  }

  async deletePackage(name: string): Promise<void> {
    const dir = this.packageDir(name);

    // Remove from disk
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore if already gone
    }

    // Clean up empty scope directory if scoped
    if (name.startsWith('@')) {
      const scopeDir = dirname(dir);
      try {
        await rmdir(scopeDir);
      } catch {
        // ENOTEMPTY or already gone, both fine
      }
    }

    // Remove from memory
    this.packuments.delete(name);
    this.invalidateCache(name);
  }

  async deleteTarball(name: string, filename: string): Promise<void> {
    const filepath = join(this.packageDir(name), filename);
    try {
      await unlink(filepath);
    } catch {
      // ignore if already gone
    }
  }

  getIndex(): string {
    if (this.indexCache !== null) {
      return this.indexCache;
    }

    const packages: Record<string, PkglabIndexEntry> = {};

    for (const [name, doc] of this.packuments) {
      // Filter dist-tags to only pkglab versions
      const filteredTags: Record<string, string> = {};
      for (const [tag, version] of Object.entries(doc['dist-tags'])) {
        if (ispkglabVersion(version)) {
          filteredTags[tag] = version;
        }
      }

      // Filter versions to only pkglab versions
      const filteredVersions = Object.keys(doc.versions).filter(ispkglabVersion);

      // Skip packages with no pkglab versions at all
      if (filteredVersions.length === 0) {
        continue;
      }

      packages[name] = {
        rev: doc._rev,
        'dist-tags': filteredTags,
        versions: filteredVersions,
      };
    }

    const index: PkglabIndex = { packages };
    this.indexCache = JSON.stringify(index);
    return this.indexCache;
  }

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    let resolve!: () => void;
    const next = new Promise<void>(r => {
      resolve = r;
    });
    this.locks.set(name, next);
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
      if (this.locks.get(name) === next) {
        this.locks.delete(name);
      }
    }
  }

  getMergedPackument(name: string): MergedCacheEntry | undefined {
    return this.mergedPackumentCache.get(name);
  }

  setMergedPackument(name: string, json: string): void {
    this.mergedPackumentCache.set(name, { json, fetchedAt: Date.now() });
  }

  private invalidateCache(name: string): void {
    this.fullJsonCache.delete(name);
    this.mergedPackumentCache.delete(name);
    this.indexCache = null;
  }

  private packageDir(name: string): string {
    return join(paths.registryStorage, name);
  }
}

export default VerbunccioStorage;
