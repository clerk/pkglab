import { unlink } from 'node:fs/promises';

import { ensureDaemonRunning } from './daemon';
import { getListenerSocketPath, getListenerPidPath, isListenerRunning } from './listener-ipc';
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

  // Wait for READY signal, process exit, or timeout
  const deadline = timeout(5000);
  const result = await Promise.race([waitForReady(proc), waitForExit(proc), deadline.promise]);
  deadline.cancel();

  if (result !== 'ready') {
    proc.kill();
    if (result === 'timeout') {
      throw new Error('Listener failed to start within 5 seconds');
    }
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Listener process exited unexpectedly: ${stderr}`);
  }

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
  const { paths } = await import('./paths');

  const fd = await openExclusive(paths.listenerLock);
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
      await unlink(paths.listenerLock).catch(() => {});
    }
  } else {
    // Another process is starting the listener. Wait for it.
    const maxWait = 10000;
    const start = Date.now();
    let delay = 100;
    while (Date.now() - start < maxWait) {
      await Bun.sleep(delay);
      if (await isListenerRunning(socketPath)) return;
      if (await isLockStale(paths.listenerLock)) {
        await unlink(paths.listenerLock).catch(() => {});
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
