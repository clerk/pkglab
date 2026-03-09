import { defineCommand } from 'citty';

import { c } from '../lib/color';
import { getListenerLogPath } from '../lib/listener-ipc';
import { log } from '../lib/log';
import { paths } from '../lib/paths';
import { discoverWorkspace } from '../lib/workspace';

const levelColors: Record<string, (s: string) => string> = {
  debug: c.dim,
  info: c.blue,
  warn: c.yellow,
  error: c.red,
  success: c.green,
};

function formatLogLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return line;
  try {
    const entry = JSON.parse(trimmed);
    const level = entry.level ?? 'info';
    const colorize = levelColors[level] ?? c.blue;
    const time = entry.time ? c.dim(new Date(entry.time).toLocaleTimeString()) + ' ' : '';
    const msg = entry.msg ?? '';

    // Collect extra fields (skip standard pino fields)
    const skip = new Set(['level', 'time', 'msg', 'pid', 'hostname']);
    const extras: string[] = [];
    for (const [k, v] of Object.entries(entry)) {
      if (!skip.has(k)) extras.push(`${k}=${JSON.stringify(v)}`);
    }
    const suffix = extras.length ? ' ' + c.dim(extras.join(' ')) : '';
    return `${time}${colorize(level)} ${msg}${suffix}`;
  } catch {
    return line;
  }
}

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

    const tailCmd = args.follow ? ['tail', '-f', ...files] : ['tail', '-50', ...files];

    if (args.raw) {
      const proc = Bun.spawn(tailCmd, { stdout: 'inherit', stderr: 'inherit' });
      await proc.exited;
      return;
    }

    // Pretty mode: tail and format JSON lines inline (no external pino-pretty dependency)
    const tailProc = Bun.spawn(tailCmd, { stdout: 'pipe', stderr: 'inherit' });
    const reader = tailProc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) process.stdout.write(formatLogLine(line) + '\n');
        }
      }
      if (buffer.trim()) {
        process.stdout.write(formatLogLine(buffer) + '\n');
      }
    } finally {
      reader.releaseLock();
    }
    await tailProc.exited;
  },
});
