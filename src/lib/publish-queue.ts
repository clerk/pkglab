/**
 * Multi-workspace publish queue with per-tag lane coalescing.
 *
 * Ported from listener-core.ts but keyed by workspaceRoot so a single
 * registry process can coordinate publishes for many workspaces.
 */

interface Lane {
  pending: Set<string>;
  root: boolean;
  force: boolean;
  single: boolean;
  shallow: boolean;
  dryRun: boolean;
}

interface WorkspaceState {
  lanes: Map<string, Lane>;
  publishing: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export interface PublishRequest {
  workspaceRoot: string;
  targets: string[];
  tag?: string;
  force?: boolean;
  shallow?: boolean;
  single?: boolean;
  root?: boolean;
  dryRun?: boolean;
}

export interface QueueResult {
  jobId: string;
  status: 'queued' | 'coalesced';
}

export interface LaneStatus {
  tag: string;
  pending: string[];
  root: boolean;
  force: boolean;
}

export interface WorkspaceStatus {
  workspaceRoot: string;
  publishing: boolean;
  lanes: LaneStatus[];
}

let logFd: number | undefined;

export function setLogFd(fd: number): void {
  logFd = fd;
}

function formatTimestamp(): string {
  return '[' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + ']';
}

let jobCounter = 0;

// Global state: Map<workspaceRoot, WorkspaceState>
const workspaces = new Map<string, WorkspaceState>();

function getWorkspaceState(workspaceRoot: string): WorkspaceState {
  let ws = workspaces.get(workspaceRoot);
  if (!ws) {
    ws = { lanes: new Map(), publishing: false, debounceTimer: null };
    workspaces.set(workspaceRoot, ws);
  }
  return ws;
}

function getLane(ws: WorkspaceState, tag: string): Lane {
  let lane = ws.lanes.get(tag);
  if (!lane) {
    lane = {
      pending: new Set(),
      root: false,
      force: false,
      single: false,
      shallow: false,
      dryRun: false,
    };
    ws.lanes.set(tag, lane);
  }
  return lane;
}

/**
 * Enqueue a publish request. Coalesces targets into per-tag lanes and
 * triggers a drain loop if one is not already running for the workspace.
 */
export function enqueuePublish(req: PublishRequest): QueueResult {
  const ws = getWorkspaceState(req.workspaceRoot);
  const tag = req.tag ?? '';
  const lane = getLane(ws, tag);

  for (const name of req.targets) {
    lane.pending.add(name);
  }
  if (req.root) lane.root = true;
  if (req.force) lane.force = true;
  if (req.single) lane.single = true;
  if (req.shallow) lane.shallow = true;
  if (req.dryRun) lane.dryRun = true;

  const jobId = `pub-${++jobCounter}`;
  const coalesced = ws.publishing;

  const names = req.targets.length > 0 ? req.targets.join(', ') : '(root)';
  const tagLabel = tag ? ` [${tag}]` : '';
  if (coalesced) {
    console.log(`${formatTimestamp()} Ping: ${names}${tagLabel} (queued, publish in progress)`);
  } else if (ws.debounceTimer) {
    console.log(`${formatTimestamp()} Ping: ${names}${tagLabel} (debounced)`);
  } else {
    console.log(`${formatTimestamp()} Ping: ${names}${tagLabel}`);
  }

  if (!ws.publishing) {
    // Debounce: collect pings arriving within 150ms into a single batch.
    // Each new ping resets the timer so rapid-fire pings coalesce.
    if (ws.debounceTimer) {
      clearTimeout(ws.debounceTimer);
    }
    ws.debounceTimer = setTimeout(() => {
      ws.debounceTimer = null;
      void drainLanes(ws, req.workspaceRoot);
    }, 150);
  }

  return { jobId, status: coalesced ? 'coalesced' : 'queued' };
}

async function drainLanes(ws: WorkspaceState, workspaceRoot: string): Promise<void> {
  ws.publishing = true;
  try {
    while (true) {
      // Find next lane with pending work
      let activeLane: Lane | undefined;
      let activeTag = '';
      for (const [tag, lane] of ws.lanes) {
        if (lane.pending.size > 0 || lane.root) {
          activeLane = lane;
          activeTag = tag;
          break;
        }
      }
      if (!activeLane) break;

      // Snapshot and reset the lane
      const names = [...activeLane.pending];
      const useRoot = activeLane.root;
      const useForce = activeLane.force;
      const useSingle = activeLane.single;
      const useShallow = activeLane.shallow;
      const useDryRun = activeLane.dryRun;
      activeLane.pending.clear();
      activeLane.root = false;
      activeLane.force = false;
      activeLane.single = false;
      activeLane.shallow = false;
      activeLane.dryRun = false;

      // Build command
      const cmd: string[] = [process.execPath];
      const isSource = process.argv[1]?.match(/\.(ts|js)$/);
      if (isSource) {
        cmd.push(process.argv[1]);
      }
      cmd.push('pub');

      if (useRoot) {
        cmd.push('--root');
      } else if (names.length > 0) {
        cmd.push(...names);
      }

      if (activeTag) cmd.push('--tag', activeTag);
      if (useForce) cmd.push('--force');
      if (useSingle) cmd.push('--single');
      if (useShallow) cmd.push('--shallow');
      if (useDryRun) cmd.push('--dry-run');

      console.log(`${formatTimestamp()} Publishing${activeTag ? ` [${activeTag}]` : ''}...`);
      if (names.length > 0 && !useRoot) {
        console.log(`  ${names.join(', ')}`);
      }

      const PUBLISH_TIMEOUT = parseInt(process.env.PKGLAB_PUB_TIMEOUT ?? '120000', 10);

      const proc = Bun.spawn(cmd, {
        cwd: workspaceRoot,
        stdout: logFd ?? 'inherit',
        stderr: logFd ?? 'inherit',
      });

      const timer = setTimeout(() => {
        console.error(`${formatTimestamp()} Publish timed out after ${PUBLISH_TIMEOUT}ms, killing...`);
        proc.kill();
        setTimeout(() => { try { proc.kill(9); } catch {} }, 5000);
      }, PUBLISH_TIMEOUT);

      const exitCode = await proc.exited;
      clearTimeout(timer);
      if (exitCode !== 0) {
        console.error(`${formatTimestamp()} Publish failed (exit ${exitCode})`);
      } else {
        console.log(`${formatTimestamp()} Publish complete`);
      }
    }
  } finally {
    ws.publishing = false;
  }
}

/**
 * Return status info for all active workspaces (used by the status endpoint).
 */
export function getQueueStatus(): WorkspaceStatus[] {
  const result: WorkspaceStatus[] = [];
  for (const [root, ws] of workspaces) {
    const lanes: LaneStatus[] = [];
    for (const [tag, lane] of ws.lanes) {
      if (lane.pending.size > 0 || lane.root) {
        lanes.push({
          tag: tag || '(default)',
          pending: [...lane.pending],
          root: lane.root,
          force: lane.force,
        });
      }
    }
    result.push({
      workspaceRoot: root,
      publishing: ws.publishing,
      lanes,
    });
  }
  return result;
}
