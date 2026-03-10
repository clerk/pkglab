import { join } from 'node:path';

import { log } from './log';
import { run } from './proc';

// Kill switch: set PKGLAB_NO_MTIME_CACHE=1 to skip the mtime fast path
// and always do full content hashing.
const DISABLE_MTIME_CACHE = process.env.PKGLAB_NO_MTIME_CACHE === '1';

export interface FileStat {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface PackageFingerprint {
  hash: string;
  fileCount: number;
  fileStats?: FileStat[];
}

// Always included in npm publishes regardless of `files` field
const ALWAYS_INCLUDE_GLOBS = ['package.json', 'README{,.*}', 'LICENSE{,.*}', 'LICENCE{,.*}', 'CHANGELOG{,.*}'];

// Collect publishable file paths for a package using pure filesystem ops.
// Replicates npm's file inclusion logic: `files` field patterns, always-included
// files, and entry points from main/module/types/bin/exports. Falls back to
// `npm pack --dry-run --json` when the package uses bundledDependencies (rare).
async function collectPublishFiles(packageDir: string, pkgJson: Record<string, any>): Promise<string[]> {
  const fileSet = new Set<string>();

  if (pkgJson.files && Array.isArray(pkgJson.files)) {
    const positivePatterns = (pkgJson.files as string[]).filter((p: string) => !p.startsWith('!'));
    const negationPatterns = (pkgJson.files as string[]).filter((p: string) => p.startsWith('!')).map((p: string) => p.slice(1));

    // Collect files matching positive patterns
    for (const pattern of positivePatterns) {
      const fileGlob = new Bun.Glob(pattern.endsWith('/') ? pattern + '**' : pattern);
      for await (const match of fileGlob.scan({ cwd: packageDir, onlyFiles: true })) {
        fileSet.add(match);
      }
      // Also treat bare names as possible directories
      if (!pattern.includes('*') && !pattern.endsWith('/')) {
        const dirGlob = new Bun.Glob(pattern + '/**');
        for await (const match of dirGlob.scan({ cwd: packageDir, onlyFiles: true })) {
          fileSet.add(match);
        }
      }
    }

    // Apply negation patterns: remove files matching !pattern entries
    if (negationPatterns.length > 0) {
      for (const neg of negationPatterns) {
        const negGlob = new Bun.Glob(neg);
        for (const file of fileSet) {
          if (negGlob.match(file)) {
            fileSet.delete(file);
          }
        }
        // Also match as directory (e.g. "dist/internal" excludes "dist/internal/foo.js")
        if (!neg.includes('*') && !neg.endsWith('/')) {
          const dirGlob = new Bun.Glob(neg + '/**');
          for (const file of fileSet) {
            if (dirGlob.match(file)) {
              fileSet.delete(file);
            }
          }
        }
      }
    }
  } else {
    // No files field: include everything minus common exclusions.
    // Apply .npmignore (or .gitignore if no .npmignore) like npm does.
    const ignorePatterns = await loadIgnorePatterns(packageDir);
    const glob = new Bun.Glob('**');
    for await (const match of glob.scan({ cwd: packageDir, onlyFiles: true })) {
      if (match.startsWith('node_modules/') || match.startsWith('.git/') || match.startsWith('.turbo/')) {
        continue;
      }
      if (ignorePatterns.length > 0 && matchesAnyPattern(match, ignorePatterns)) {
        continue;
      }
      fileSet.add(match);
    }
  }

  // Always-included files
  for (const pattern of ALWAYS_INCLUDE_GLOBS) {
    const glob = new Bun.Glob(pattern);
    for await (const match of glob.scan({ cwd: packageDir, onlyFiles: true })) {
      fileSet.add(match);
    }
  }

  // Entry points from package.json fields
  for (const field of ['main', 'module', 'types', 'typings'] as const) {
    const val = pkgJson[field];
    if (typeof val === 'string') {
      fileSet.add(val.replace(/^\.\//, ''));
    }
  }

  // bin field (string or object)
  if (typeof pkgJson.bin === 'string') {
    fileSet.add(pkgJson.bin.replace(/^\.\//, ''));
  } else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    for (const v of Object.values(pkgJson.bin)) {
      if (typeof v === 'string') {
        fileSet.add(v.replace(/^\.\//, ''));
      }
    }
  }

  // exports field: recursively extract string leaf values starting with "./"
  if (pkgJson.exports) {
    collectExportPaths(pkgJson.exports, fileSet);
  }

  return [...fileSet].toSorted();
}

// Load ignore patterns from .npmignore (preferred) or .gitignore.
// Returns glob patterns to exclude. Comments and blank lines are stripped.
async function loadIgnorePatterns(packageDir: string): Promise<string[]> {
  // .npmignore takes precedence over .gitignore (npm behavior)
  for (const file of ['.npmignore', '.gitignore']) {
    const f = Bun.file(join(packageDir, file));
    if (await f.exists()) {
      const content = await f.text();
      return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'));
    }
  }
  return [];
}

// Check if a file path matches any of the ignore patterns.
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    if (glob.match(filePath)) {
      return true;
    }
    // Also match as directory prefix (e.g. "dist" should match "dist/foo.js")
    if (!pattern.includes('*') && !pattern.includes('/')) {
      const dirGlob = new Bun.Glob(pattern + '/**');
      if (dirGlob.match(filePath)) {
        return true;
      }
    }
  }
  return false;
}

// Walk the exports map recursively, collecting relative file paths
function collectExportPaths(node: unknown, out: Set<string>): void {
  if (typeof node === 'string') {
    if (node.startsWith('./')) {
      out.add(node.slice(2));
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectExportPaths(item, out);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const val of Object.values(node)) {
      collectExportPaths(val, out);
    }
  }
}

// Collect mtime and size for a list of files. Returns sorted by path.
async function collectFileStats(packageDir: string, files: string[]): Promise<FileStat[]> {
  const stats: FileStat[] = [];
  for (const file of files) {
    const f = Bun.file(join(packageDir, file));
    if (!(await f.exists())) {
      continue;
    }
    const s = await f.stat();
    stats.push({ path: file, mtimeMs: s.mtimeMs, size: s.size });
  }
  return stats.toSorted((a, b) => a.path.localeCompare(b.path));
}

// Check if all file stats match between cached and current state.
// Returns true if every file has the same mtime and size.
function fileStatsMatch(cached: FileStat[], current: FileStat[]): boolean {
  if (cached.length !== current.length) {
    return false;
  }
  for (let i = 0; i < cached.length; i++) {
    if (cached[i].path !== current[i].path || cached[i].mtimeMs !== current[i].mtimeMs || cached[i].size !== current[i].size) {
      return false;
    }
  }
  return true;
}

// Fingerprint a package by hashing the files npm would publish.
// Uses pure filesystem globbing instead of spawning npm processes.
// Falls back to `npm pack --dry-run --json` for packages with bundledDependencies.
// When previous fingerprint data with fileStats is provided, uses mtime+size gating
// to skip content hashing if no file metadata has changed.
export async function fingerprintPackage(
  packageDir: string,
  previous?: PackageFingerprint,
): Promise<PackageFingerprint> {
  const pkgJson = await Bun.file(join(packageDir, 'package.json')).json();

  // bundledDependencies pulls from node_modules which we can't replicate cheaply
  if (pkgJson.bundledDependencies?.length || pkgJson.bundleDependencies?.length) {
    return fingerprintPackageStrict(packageDir);
  }

  const files = await collectPublishFiles(packageDir, pkgJson);

  // Collect ignore files that exist (these affect the hash)
  const ignoreFiles: string[] = [];
  for (const ignoreFile of ['.npmignore', '.gitignore']) {
    const f = Bun.file(join(packageDir, ignoreFile));
    if (await f.exists()) {
      ignoreFiles.push(ignoreFile);
    }
  }

  // mtime+size gating: if we have previous stats, check if all files match.
  // The stat list includes both publishable files and ignore files, so we
  // build the full current list before comparing.
  // Skipped entirely when PKGLAB_NO_MTIME_CACHE=1 is set.
  if (!DISABLE_MTIME_CACHE && previous?.fileStats) {
    const allFiles = [...files, ...ignoreFiles];
    const currentStats = await collectFileStats(packageDir, allFiles);
    if (fileStatsMatch(previous.fileStats, currentStats)) {
      // All files unchanged by mtime+size, reuse cached hash
      return { hash: previous.hash, fileCount: files.length, fileStats: currentStats };
    }
    // Fall through to full content hash
  }

  // Content hashing with TOCTOU protection: after hashing, re-stat all files
  // and compare against the pre-hash stats. If anything changed during hashing,
  // discard the result and re-hash once. Only retries once to avoid infinite loops.
  let retried = false;
  while (true) {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update('pkglab-fp-v2\0');

    // Include ignore files in the hash so rule changes invalidate the fingerprint
    for (const ignoreFile of ignoreFiles) {
      const f = Bun.file(join(packageDir, ignoreFile));
      hasher.update(ignoreFile);
      hasher.update('\0');
      for await (const chunk of f.stream()) {
        hasher.update(chunk);
      }
      hasher.update('\0');
    }

    const fileStats: FileStat[] = [];
    for (const file of files) {
      const f = Bun.file(join(packageDir, file));
      if (!(await f.exists())) {
        continue;
      }
      const s = await f.stat();
      fileStats.push({ path: file, mtimeMs: s.mtimeMs, size: s.size });
      for await (const chunk of f.stream()) {
        hasher.update(chunk);
      }
      hasher.update('\0');
      hasher.update(file);
      hasher.update('\0');
    }

    // Sort fileStats by path for deterministic comparison
    fileStats.sort((a, b) => a.path.localeCompare(b.path));

    // Also include ignore file stats so changes to ignore files invalidate the mtime cache
    for (const ignoreFile of ignoreFiles) {
      const f = Bun.file(join(packageDir, ignoreFile));
      if (!(await f.exists())) {
        continue;
      }
      const s = await f.stat();
      fileStats.push({ path: ignoreFile, mtimeMs: s.mtimeMs, size: s.size });
    }
    // Re-sort after adding ignore files
    fileStats.sort((a, b) => a.path.localeCompare(b.path));

    // Post-hash TOCTOU check: re-stat files and verify nothing changed during hashing.
    // If stats diverge, a file was modified mid-hash, so the result is unreliable.
    const allFiles = [...files, ...ignoreFiles];
    const postStats = await collectFileStats(packageDir, allFiles);
    if (!fileStatsMatch(fileStats, postStats)) {
      if (!retried) {
        retried = true;
        continue; // re-hash once
      }
      // Second mismatch: return the hash but drop fileStats so the next run
      // does a full content hash instead of trusting stale stat data.
      log.warn(`Files changed during fingerprinting for ${packageDir}, skipping stat cache`);
      return { hash: hasher.digest('hex'), fileCount: files.length };
    }

    return { hash: hasher.digest('hex'), fileCount: files.length, fileStats };
  }
}

// Strict fallback: uses npm pack --dry-run --json for exact file list.
// Only used for packages with bundledDependencies.
async function fingerprintPackageStrict(packageDir: string): Promise<PackageFingerprint> {
  const result = await run(['npm', 'pack', '--dry-run', '--json'], { cwd: packageDir });
  if (result.exitCode !== 0) {
    throw new Error(`npm pack failed in ${packageDir}: ${result.stderr}`);
  }

  const packInfo = JSON.parse(result.stdout);
  const files: string[] = packInfo[0].files.map((f: { path: string }) => f.path).toSorted();

  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update('pkglab-fp-v2\0');
  for (const file of files) {
    const f = Bun.file(join(packageDir, file));
    for await (const chunk of f.stream()) {
      hasher.update(chunk);
    }
    hasher.update('\0');
    hasher.update(file);
    hasher.update('\0');
  }

  return { hash: hasher.digest('hex'), fileCount: files.length };
}

// Fingerprint multiple packages in parallel.
// Safe to run unbounded since there are no subprocess spawns, just filesystem reads.
// When previousFingerprints is provided, passes cached data to each package so the
// mtime+size gate can skip content hashing for unchanged files.
export async function fingerprintPackages(
  packages: { name: string; dir: string }[],
  previousFingerprints?: Map<string, PackageFingerprint>,
): Promise<Map<string, PackageFingerprint>> {
  const results = new Map<string, PackageFingerprint>();
  const fps = await Promise.all(
    packages.map(p => fingerprintPackage(p.dir, previousFingerprints?.get(p.name))),
  );
  for (let i = 0; i < packages.length; i++) {
    results.set(packages[i].name, fps[i]);
  }
  return results;
}
