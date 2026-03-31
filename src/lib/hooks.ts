import { join } from 'node:path';

import { log } from './log';
import { bunEnv } from './proc';

export interface PkglabHookPayload {
  schemaVersion: 1;
  event: 'add' | 'restore' | 'update';
  phase: 'pre' | 'post' | 'error';
  packages: Array<{ name: string; version: string; previous?: string }>;
  tag: string | null;
  repoPath: string;
  registryUrl: string;
  packageManager: string;
  error: { stage: string; message: string; failedHook: string | null } | null;
}

export type HookStatus = 'not_found' | 'ok' | 'failed' | 'aborted' | 'timed_out';

export interface HookResult {
  status: HookStatus;
  exitCode?: number;
  durationMs: number;
}

type HookRunner = 'bun' | 'bash' | 'direct';

const EXTENSIONS: Array<{ ext: string; runner: HookRunner }> = [
  { ext: '.ts', runner: 'bun' },
  { ext: '.sh', runner: 'bash' },
  { ext: '', runner: 'direct' },
];

const DEFAULT_TIMEOUT_MS = 30_000;

function getTimeoutMs(): number {
  const envVal = process.env['PKGLAB_HOOK_TIMEOUT_MS'];
  if (envVal) {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Check for a hook file in .pkglab/hooks/ with priority: .ts > .sh > extensionless.
 * Returns the path and runner type, or null if no hook exists.
 */
export async function findHook(
  repoPath: string,
  eventName: string,
): Promise<{ path: string; runner: HookRunner } | null> {
  const hooksDir = join(repoPath, '.pkglab', 'hooks');

  for (const { ext, runner } of EXTENSIONS) {
    const hookPath = join(hooksDir, `${eventName}${ext}`);
    const file = Bun.file(hookPath);
    if (await file.exists()) {
      return { path: hookPath, runner };
    }
  }

  return null;
}

/**
 * Spawn a hook process and wait for it to complete (or time out).
 */
async function executeHook(
  hookPath: string,
  payload: PkglabHookPayload,
  runner: HookRunner,
  timeoutMs: number,
): Promise<HookResult> {
  const json = JSON.stringify(payload);

  let cmd: string[];
  switch (runner) {
    case 'bun':
      cmd = [process.execPath, 'run', hookPath, json];
      break;
    case 'bash':
      cmd = ['bash', hookPath, json];
      break;
    case 'direct':
      cmd = [hookPath, json];
      break;
  }

  const start = performance.now();

  // BUN_BE_BUN=1 for .ts hooks so the compiled binary acts as bun runtime
  const proc = Bun.spawn(cmd, {
    cwd: payload.repoPath,
    env: runner === 'bun' ? bunEnv() : undefined,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    // Escalate to SIGKILL after 5s grace period
    killTimer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  }, timeoutMs);

  try {
    const [exitCode, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const durationMs = Math.round(performance.now() - start);

    if (timedOut) {
      log.warn(`Hook timed out after ${timeoutMs}ms: ${hookPath}`);
      return { status: 'timed_out', exitCode, durationMs };
    }

    if (exitCode !== 0) {
      if (stderr.trim()) {
        log.warn(stderr.trim());
      }
      // Non-zero exit in a pre-hook means abort, otherwise it's a failure
      const status: HookStatus = payload.phase === 'pre' ? 'aborted' : 'failed';
      return { status, exitCode, durationMs };
    }

    return { status: 'ok', exitCode: 0, durationMs };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
}

export interface HookInput {
  event: 'add' | 'restore' | 'update';
  packages: Array<{ name: string; version: string; previous?: string }>;
  tag: string | null;
  repoPath: string;
  registryUrl: string;
  packageManager: string;
}

type ErrorInput = HookInput & {
  error: NonNullable<PkglabHookPayload['error']>;
};

function buildPayload(
  ctx: HookInput,
  phase: PkglabHookPayload['phase'],
  error?: PkglabHookPayload['error'],
): PkglabHookPayload {
  return {
    schemaVersion: 1,
    event: ctx.event,
    phase,
    packages: ctx.packages,
    tag: ctx.tag,
    repoPath: ctx.repoPath,
    registryUrl: ctx.registryUrl,
    packageManager: ctx.packageManager,
    error: error ?? null,
  };
}

export async function runPreHook(ctx: HookInput): Promise<HookResult> {
  const hookName = `pre-${ctx.event}`;
  const found = await findHook(ctx.repoPath, hookName);
  if (!found) {
    return { status: 'not_found', durationMs: 0 };
  }

  return executeHook(found.path, buildPayload(ctx, 'pre'), found.runner, getTimeoutMs());
}

/**
 * Find and run the post-{event} hook. Returns not_found if no hook file exists.
 */
export async function runPostHook(ctx: HookInput): Promise<HookResult> {
  const hookName = `post-${ctx.event}`;
  const found = await findHook(ctx.repoPath, hookName);
  if (!found) {
    return { status: 'not_found', durationMs: 0 };
  }

  return executeHook(found.path, buildPayload(ctx, 'post'), found.runner, getTimeoutMs());
}

/**
 * Find and run the on-error hook. Returns not_found if no hook file exists.
 * Failures are swallowed and logged (non-recursive).
 */
export async function runErrorHook(ctx: ErrorInput): Promise<HookResult> {
  const found = await findHook(ctx.repoPath, 'on-error');
  if (!found) {
    return { status: 'not_found', durationMs: 0 };
  }

  try {
    return await executeHook(found.path, buildPayload(ctx, 'error', ctx.error), found.runner, getTimeoutMs());
  } catch {
    log.warn('on-error hook threw an exception, ignoring');
    return { status: 'failed', durationMs: 0 };
  }
}
