import { unlink } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import { LockAcquisitionError } from './errors';
import { paths } from './paths';
import { isProcessAlive } from './proc';

export async function acquirePublishLock(): Promise<() => Promise<void>> {
  const lockPath = paths.publishLock;

  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = await openExclusive(lockPath);
    if (fd) {
      try {
        await writeAndClose(fd, String(process.pid));
      } catch (err) {
        await fd.close().catch(() => {});
        throw err;
      }
      return async () => {
        await unlink(lockPath).catch(() => {});
      };
    }

    // Lock exists, check if stale
    if (await isLockStale(lockPath)) {
      await unlink(lockPath).catch(() => {});
      continue; // retry openExclusive
    }

    throw new LockAcquisitionError('Another pkglab pub is running');
  }

  throw new LockAcquisitionError('Failed to acquire publish lock after retries');
}

export async function openExclusive(path: string): Promise<import('node:fs/promises').FileHandle | null> {
  try {
    const { constants } = await import('node:fs');
    return await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      return null;
    }
    throw err;
  }
}

export async function writeAndClose(fd: import('node:fs/promises').FileHandle, content: string): Promise<void> {
  await fd.write(content);
  await fd.datasync();
  await fd.close();
}

export async function isLockStale(lockPath: string): Promise<boolean> {
  const file = Bun.file(lockPath);
  if (!(await file.exists())) {
    return false;
  }
  const content = await file.text();
  const holderPid = parseInt(content.trim(), 10);
  if (isNaN(holderPid)) {
    return true;
  }
  return !isProcessAlive(holderPid);
}
