import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureDaemonRunning } from './daemon';
import { getListenerSocketPath, getListenerPidPath, getListenerLockPath, isListenerRunning } from './listener-ipc';
import { log } from './log';
import { isProcessAlive, waitForReady, waitForExit, timeout, gracefulStop, validatePidStartTime } from './proc';

export interface ListenerInfo {
  pid: number;
  running: boolean;
  workspaceRoot: string;
}

export async function getListenerDaemonStatus(workspaceRoot: string): Promise<ListenerInfo | null> {
  const pidPath = getListenerPidPath(workspaceRoot);
  const pidFile = Bun.file(pidPath);
  if (!(await pidFile.exists())) {
    return null;
  }

  try {
    const data = JSON.parse(await pidFile.text());
    const pid = data.pid as number;
    if (!pid || !isProcessAlive(pid)) {
      await unlink(pidPath).catch(() => {});
      return null;
    }
    // Validate PID is actually our listener (not a recycled PID)
    if (data.startedAt) {
      if (!(await validatePidStartTime(pid, data.startedAt))) {
        await unlink(pidPath).catch(() => {});
        return null;
      }
    }
    return {
      pid,
      running: true,
      workspaceRoot: data.workspaceRoot ?? workspaceRoot,
    };
  } catch {
    await unlink(pidPath).catch(() => {});
    return null;
  }
}

export async function startListenerDaemon(workspaceRoot: string): Promise<ListenerInfo> {
  // Ensure registry is running first
  await ensureDaemonRunning();

  const socketPath = getListenerSocketPath(workspaceRoot);

  // Check if already running
  if (await isListenerRunning(socketPath)) {
    const status = await getListenerDaemonStatus(workspaceRoot);
    if (status) {
      return status;
    }
  }

  // Build command: same pattern as daemon.ts startDaemon()
  const isSource = process.argv[1]?.match(/\.(ts|js)$/);
  const cmd = isSource
    ? [process.execPath, process.argv[1], '--__listener', workspaceRoot]
    : [process.execPath, '--__listener', workspaceRoot];

  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Drain stderr concurrently to prevent pipe buffer deadlock.
  const stderrReader = proc.stderr.getReader();
  const stderrChunks: Uint8Array[] = [];
  const stderrPromise = (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(value);
      }
    } catch {}
    return Buffer.concat(stderrChunks).toString();
  })();

  // Wait for READY signal, process exit, or timeout
  const deadline = timeout(5000);
  const result = await Promise.race([waitForReady(proc), waitForExit(proc), deadline.promise]);
  deadline.cancel();

  if (result !== 'ready') {
    proc.kill();
    if (result === 'timeout') {
      throw new Error('Listener failed to start within 5 seconds');
    }
    const stderr = await stderrPromise;
    throw new Error(`Listener process exited unexpectedly: ${stderr}`);
  }

  // Cancel stderr drain so the parent can exit while the listener runs
  await stderrReader.cancel();
  proc.unref();

  const status = await getListenerDaemonStatus(workspaceRoot);
  return status ?? { pid: proc.pid, running: true, workspaceRoot };
}

export async function ensureListenerRunning(workspaceRoot: string): Promise<void> {
  const socketPath = getListenerSocketPath(workspaceRoot);
  if (await isListenerRunning(socketPath)) {
    return;
  }

  const { openExclusive, writeAndClose, isLockStale } = await import('./lock');

  const lockPath = getListenerLockPath(workspaceRoot);
  const fd = await openExclusive(lockPath);
  if (fd) {
    try {
      await writeAndClose(fd, String(process.pid));

      // Re-check after acquiring lock
      if (await isListenerRunning(socketPath)) {
        return;
      }

      log.info('Starting listener...');
      const info = await startListenerDaemon(workspaceRoot);
      log.success(`Listener running (PID ${info.pid})`);
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  } else {
    // Another process is starting the listener. Wait for it.
    const maxWait = 10000;
    const start = Date.now();
    let delay = 100;
    while (Date.now() - start < maxWait) {
      await Bun.sleep(delay);
      if (await isListenerRunning(socketPath)) return;
      if (await isLockStale(lockPath)) {
        await unlink(lockPath).catch(() => {});
        return ensureListenerRunning(workspaceRoot);
      }
      delay = Math.min(delay * 2, 500);
    }
    throw new Error('Listener did not become ready');
  }
}

export async function stopListener(workspaceRoot: string): Promise<void> {
  const status = await getListenerDaemonStatus(workspaceRoot);
  if (!status?.running) {
    return;
  }

  await gracefulStop(status.pid);

  const pidPath = getListenerPidPath(workspaceRoot);
  const socketPath = getListenerSocketPath(workspaceRoot);
  await unlink(pidPath).catch(() => {});
  await unlink(socketPath).catch(() => {});
}

export async function stopAllListeners(): Promise<number> {
  const { paths } = await import('./paths');
  let stopped = 0;
  try {
    const files = await readdir(paths.listenersDir);
    const pidFiles = files.filter(f => f.endsWith('.pid'));
    for (const pidFile of pidFiles) {
      try {
        const pidPath = join(paths.listenersDir, pidFile);
        const data = JSON.parse(await Bun.file(pidPath).text());
        if (data.pid && isProcessAlive(data.pid)) {
          await gracefulStop(data.pid);
          stopped++;
        }
        await unlink(pidPath).catch(() => {});
        // Clean up corresponding socket
        const socketPath = pidPath.replace(/\.pid$/, '.sock');
        await unlink(socketPath).catch(() => {});
      } catch {}
    }
  } catch {}
  return stopped;
}
