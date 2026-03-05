/**
 * Environment vars that make the compiled binary act as the plain bun CLI.
 * Setting BUN_BE_BUN=1 tells a compiled Bun executable to ignore its bundled
 * entrypoint and expose all bun CLI commands (publish, install, run, etc.).
 * In source mode this is harmless since process.execPath is already bun.
 */
export function bunEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...process.env, BUN_BE_BUN: '1', ...extra };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
}

export async function run(cmd: string[], options: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let killed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout) {
    timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, options.timeout);
  }

  // Drain pipes concurrently with waiting for exit to avoid deadlocks
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (timer) clearTimeout(timer);
  if (killed) {
    throw new Error(`Command timed out after ${options.timeout}ms: ${cmd.join(' ')}`);
  }

  return { stdout, stderr, exitCode };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Shared daemon lifecycle helpers

export async function waitForReady(proc: ReturnType<typeof Bun.spawn>): Promise<'ready'> {
  const stdout = proc.stdout;
  if (!stdout || typeof stdout === 'number') {
    throw new Error('stdout is not a readable stream');
  }
  const reader = (stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error('stdout closed before READY');
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('READY')) {
        return 'ready';
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function waitForExit(proc: ReturnType<typeof Bun.spawn>): Promise<'exited'> {
  await proc.exited;
  return 'exited';
}

export function timeout(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return { promise, cancel: () => clearTimeout(timer!) };
}

export async function gracefulStop(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  for (let i = 0; i < 20; i++) {
    await Bun.sleep(250);
    if (!isProcessAlive(pid)) {
      return;
    }
  }

  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

export async function validatePidStartTime(pid: number, startedAt: number): Promise<boolean> {
  try {
    const result = await run(['ps', '-p', String(pid), '-o', 'lstart='], { timeout: 5000 });
    if (result.exitCode === 0 && result.stdout.trim()) {
      const psTime = new Date(result.stdout.trim()).getTime();
      if (Number.isFinite(psTime)) {
        return Math.abs(psTime - startedAt) < 5000;
      }
    }
  } catch {}

  return false;
}
