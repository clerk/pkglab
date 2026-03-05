import { unlink } from 'node:fs/promises';

import type { DaemonInfo } from '../types';

import { loadConfig } from './config';
import { DaemonAlreadyRunningError, DaemonStartTimeoutError } from './errors';
import { openExclusive, writeAndClose, isLockStale } from './lock';
import { log } from './log';
import { paths } from './paths';
import { isProcessAlive, run, waitForReady, waitForExit, timeout, gracefulStop, validatePidStartTime } from './proc';

export async function startDaemon(): Promise<DaemonInfo> {
  const existing = await getDaemonStatus();
  if (existing?.running) {
    throw new DaemonAlreadyRunningError(`Already running on port ${existing.port} (PID ${existing.pid})`);
  }

  // Clean stale PID if exists
  const pidFile = Bun.file(paths.pid);
  if (await pidFile.exists()) {
    await unlink(paths.pid);
  }

  const config = await loadConfig();

  // In compiled mode, process.argv[1] is a subcommand (e.g. "up").
  // In source mode, process.argv[1] is the script path (e.g. "src/index.ts").
  const startedAt = Date.now();

  const isSource = process.argv[1]?.match(/\.(ts|js)$/);
  const cmd = isSource ? [process.execPath, process.argv[1], '--__worker'] : [process.execPath, '--__worker'];

  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Drain stderr concurrently to prevent pipe buffer deadlock.
  // We read via a reader so we can cancel it on success (the daemon keeps
  // stderr open, which would otherwise keep the parent process alive).
  const stderrReader = proc.stderr.getReader();
  const stderrChunks: Uint8Array[] = [];
  const stderrPromise = (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(value);
      }
    } catch {
      // reader cancelled or stream errored
    }
    return Buffer.concat(stderrChunks).toString();
  })();

  // Wait for READY signal, process exit, or timeout
  const deadline = timeout(10000);
  const result = await Promise.race([waitForReady(proc), waitForExit(proc), deadline.promise]);
  deadline.cancel();

  if (result !== 'ready') {
    proc.kill();
    if (result === 'timeout') {
      throw new Error('Registry failed to start within 10 seconds');
    }
    const stderr = await stderrPromise;
    throw new Error(`Registry process exited unexpectedly: ${stderr}`);
  }

  // Cancel stderr drain so the parent can exit while the daemon runs
  await stderrReader.cancel();

  // Write PID only after confirmed READY
  await Bun.write(paths.pid, JSON.stringify({ pid: proc.pid, port: config.port, startedAt }));
  proc.unref();

  return { pid: proc.pid, port: config.port, running: true };
}

export async function ensureDaemonRunning(): Promise<DaemonInfo> {
  const existing = await getDaemonStatus();
  if (existing?.running) {
    return existing;
  }

  const fd = await openExclusive(paths.daemonLock);

  if (fd) {
    try {
      await writeAndClose(fd, String(process.pid));

      const rechecked = await getDaemonStatus();
      if (rechecked?.running) {
        return rechecked;
      }

      log.info('Starting registry...');
      const info = await startDaemon();
      log.success(`pkglab running on http://127.0.0.1:${info.port} (PID ${info.pid})`);
      return info;
    } finally {
      await unlink(paths.daemonLock).catch(() => {});
    }
  }

  return waitForDaemon();
}

async function waitForDaemon(): Promise<DaemonInfo> {
  log.info('Waiting for registry to start...');
  const maxWait = 15000;
  const start = Date.now();
  let delay = 100;

  while (Date.now() - start < maxWait) {
    if (await isLockStale(paths.daemonLock)) {
      await unlink(paths.daemonLock).catch(() => {});
      return ensureDaemonRunning();
    }

    await Bun.sleep(delay);
    const status = await getDaemonStatus();
    if (status?.running) {
      return status;
    }
    delay = Math.min(delay * 2, 1000);
  }

  throw new DaemonStartTimeoutError();
}

export async function stopDaemon(): Promise<void> {
  const status = await getDaemonStatus();
  if (!status?.running) {
    return;
  }

  await gracefulStop(status.pid);

  // Only unlink if PID file still points to the process we stopped
  const current = await getDaemonStatus();
  if (!current || current.pid === status.pid) {
    await unlink(paths.pid).catch(() => {});
  }
}

export async function getDaemonStatus(): Promise<DaemonInfo | null> {
  const pidFile = Bun.file(paths.pid);
  if (!(await pidFile.exists())) {
    return null;
  }

  const content = await pidFile.text();
  let pid: number;
  let port: number | undefined;
  let startedAt: number | undefined;

  try {
    const data = JSON.parse(content.trim());
    pid = data.pid;
    port = data.port;
    startedAt = data.startedAt;
  } catch {
    // Legacy plain-number format
    pid = parseInt(content.trim(), 10);
  }

  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return null;
  }

  if (!isProcessAlive(pid)) {
    await unlink(paths.pid).catch(() => {});
    return null;
  }

  if (!(await validatePid(pid, port, startedAt))) {
    await unlink(paths.pid).catch(() => {});
    return null;
  }

  const config = await loadConfig();
  return { pid, port: port ?? config.port, running: true };
}

async function validatePid(pid: number, port: number | undefined, startedAt?: number): Promise<boolean> {
  // Fast path: validate process start time via ps
  if (startedAt) {
    const valid = await validatePidStartTime(pid, startedAt);
    if (valid) return true;
  } else {
    // Legacy: check command string (pidfiles without startedAt)
    try {
      const result = await run(['ps', '-p', String(pid), '-o', 'command='], { timeout: 5000 });
      if (result.exitCode === 0) {
        const match =
          result.stdout.includes('verbunccio-worker') ||
          result.stdout.includes('pkglab') ||
          (result.stdout.includes('bun') && result.stdout.includes('verbunccio'));
        if (match) return true;
      }
    } catch {}
  }

  // Fallback: HTTP ping handles platforms where ps date parsing fails (Linux/JSC)
  if (port) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/-/ping`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  // If startedAt is set, time validation failed but process IS alive
  // (isProcessAlive passed in getDaemonStatus). Without a port to ping,
  // assume it's ours rather than orphaning the daemon.
  return startedAt !== undefined;
}
