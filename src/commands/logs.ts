import { defineCommand } from 'citty';

import { getListenerLogPath } from '../lib/listener-ipc';
import { log } from '../lib/log';
import { paths } from '../lib/paths';
import { discoverWorkspace } from '../lib/workspace';

export default defineCommand({
  meta: { name: 'logs', description: 'Tail pkglab logs' },
  args: {
    follow: { type: 'boolean', alias: 'f', description: 'Stream logs', default: false },
    listener: { type: 'boolean', description: 'Show only listener logs', default: false },
    registry: { type: 'boolean', description: 'Show only registry logs', default: false },
    raw: { type: 'boolean', description: 'Show raw JSON Lines without pretty formatting', default: false },
  },
  async run({ args }) {
    const files: string[] = [];

    // Registry logs (unless --listener only)
    if (!args.listener) {
      const registryLog = Bun.file(paths.logFile);
      if (await registryLog.exists()) {
        files.push(paths.logFile);
      }
    }

    // Listener logs (unless --registry only)
    if (!args.registry) {
      try {
        const workspace = await discoverWorkspace(process.cwd());
        const listenerLogPath = getListenerLogPath(workspace.root);
        const listenerLog = Bun.file(listenerLogPath);
        if (await listenerLog.exists()) {
          files.push(listenerLogPath);
        }
      } catch {
        // Not in a workspace, skip listener logs
      }
    }

    if (files.length === 0) {
      log.warn('No log files found');
      return;
    }

    if (args.raw) {
      // Raw mode: plain tail
      const cmd = args.follow ? ['tail', '-f', ...files] : ['tail', '-50', ...files];
      const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
      await proc.exited;
      return;
    }

    // Pretty mode: pipe through pino-pretty
    const tailCmd = args.follow ? ['tail', '-f', ...files] : ['tail', '-50', ...files];
    const tailProc = Bun.spawn(tailCmd, { stdout: 'pipe', stderr: 'inherit' });

    const prettyProc = Bun.spawn(
      [process.execPath, 'node_modules/.bin/pino-pretty', '--colorize', '--ignore', 'pid,hostname'],
      {
        stdin: tailProc.stdout,
        stdout: 'inherit',
        stderr: 'inherit',
        env: { ...process.env as Record<string, string>, BUN_BE_BUN: '1' },
      },
    );

    await Promise.all([tailProc.exited, prettyProc.exited]);
  },
});
