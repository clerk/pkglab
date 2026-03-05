import { unlink } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import { LockAcquisitionError } from './errors';
import { paths } from './paths';
import { isProcessAlive } from './proc';

export async function acquirePublishLock(): Promise<() => Promise<void>> {
  const lockPath = paths.publishLock;
  const fd = await openExclusive(lockPath);

  if (fd === null) {
    if (await isLockStale(lockPath)) {
      await unlink(lockPath).catch(() => {});
      const retryFd = await openExclusive(lockPath);
      if (retryFd === null) {
        throw new LockAcquisitionError('Failed to acquire publish lock after clearing stale lock');
      }
      await writeAndClose(retryFd, String(process.pid));
    } else {
      throw new LockAcquisitionError('Another pkglab pub is running');
    }
  } else {
    await writeAndClose(fd, String(process.pid));
  }

  return async () => {
    await unlink(lockPath).catch(() => {});
  };
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
