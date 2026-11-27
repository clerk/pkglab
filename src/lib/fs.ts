import { lstat, realpath, rename } from 'node:fs/promises';
import { dirname, sep } from 'node:path';

import { pkglabError } from './errors';

export async function isSymlink(path: string): Promise<boolean> {
  const s = await lstat(path).catch(() => null);
  return s?.isSymbolicLink() ?? false;
}

/** True if path is a symlink, or its folder resolves outside repoPath (e.g. a symlinked `.husky`). */
export async function escapesRepo(repoPath: string, path: string): Promise<boolean> {
  if (await isSymlink(path)) {
    return true;
  }
  const [root, parent] = await Promise.all([realpath(repoPath), realpath(dirname(path)).catch(() => null)]);
  return parent !== null && parent !== root && !parent.startsWith(root + sep);
}

/** Refuse to read or write repo files that are symlinks, so a repo can't point pkglab at files outside it. */
export async function assertNotSymlink(path: string): Promise<void> {
  if (await isSymlink(path)) {
    throw new pkglabError(`Refusing to modify ${path}: it is a symlink`);
  }
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, content);
  await rename(tmp, path);
}
