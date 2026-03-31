import { defineCommand } from 'citty';

import { c } from '../lib/color';
import { loadConfig } from '../lib/config';
import { log } from '../lib/log';

export default defineCommand({
  meta: {
    name: 'listen',
    description: 'Listen for publish signals (deprecated)',
  },
  args: {
    verbose: {
      type: 'boolean',
      description: 'Show detailed output',
      default: false,
      alias: 'v',
    },
  },
  async run() {
    log.warn('The listen command is deprecated. Publish coalescing is now built into the registry server.');
    log.info('Use ' + c.blue('pkglab pub --ping') + ' to send publish requests to the registry.');
    log.line('');

    // Show current queue status from the registry
    const config = await loadConfig();
    const url = `http://127.0.0.1:${config.port}/-/pkglab/publish/status`;

    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    } catch {
      log.error('Registry is not running. Start it with: pkglab up');
      return;
    }

    if (!resp.ok) {
      log.error(`Failed to fetch queue status (HTTP ${resp.status})`);
      return;
    }

    const data = (await resp.json()) as {
      workspaces: Array<{
        workspaceRoot: string;
        publishing: boolean;
        lanes: Array<{ tag: string; pending: string[]; root: boolean; force: boolean }>;
      }>;
    };

    if (data.workspaces.length === 0) {
      log.dim('No active publish queues.');
      return;
    }

    log.info('Publish queue status:');
    for (const ws of data.workspaces) {
      const status = ws.publishing ? c.green('publishing') : c.dim('idle');
      log.line(`  ${ws.workspaceRoot} [${status}]`);
      if (ws.lanes.length > 0) {
        for (const lane of ws.lanes) {
          const tag = lane.tag;
          const pending = lane.pending.length > 0 ? lane.pending.join(', ') : lane.root ? '(root)' : '(empty)';
          log.line(`    ${tag}: ${pending}`);
        }
      }
    }
  },
});
