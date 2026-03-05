#!/usr/bin/env bun

// Hidden flag: when the daemon spawns itself as a worker, run the registry server
if (process.argv.includes('--__worker')) {
  const { main } = await import('./lib/verbunccio-worker');
  await main();
  // Keep process alive (server is listening)
  await new Promise(() => {});
}

// Hidden flag: detached prune subprocess
if (process.argv.includes('--__prune')) {
  const { pruneAll } = await import('./lib/prune');
  const idx = process.argv.indexOf('--__prune');
  const port = Number(process.argv[idx + 1]);
  const pruneKeep = Number(process.argv[idx + 2]);
  const tag = process.argv[idx + 3];
  await pruneAll({ port, prune_keep: pruneKeep }, tag || undefined).catch(() => {});
  process.exit(0);
}

// Hidden flag: listener daemon for a workspace
if (process.argv.includes('--__listener')) {
  const idx = process.argv.indexOf('--__listener');
  const workspaceRoot = process.argv[idx + 1];
  if (!workspaceRoot) {
    console.error('--__listener requires a workspace root path');
    process.exit(1);
  }
  const { main } = await import('./lib/listener-worker');
  await main(workspaceRoot);
  // Keep process alive (listener server is listening)
  await new Promise(() => {});
}

import { defineCommand, runMain } from 'citty';

import { ensurepkglabDirs } from './lib/config';
import { CommandError, SilentExitError, pkglabError } from './lib/errors';
import { log } from './lib/log';
import { getVersion } from './lib/version';

const pkgVersion = await getVersion();

if (process.argv[2] === 'version') {
  process.argv[2] = '--version';
}

const cmd = defineCommand({
  meta: {
    name: 'pkglab',
    version: pkgVersion,
    description: 'Local package development CLI',
  },
  subCommands: {
    up: () => import('./commands/up').then(m => m.default),
    down: () => import('./commands/down').then(m => m.default),
    status: () => import('./commands/status').then(m => m.default),
    logs: () => import('./commands/logs').then(m => m.default),
    pub: () => import('./commands/pub').then(m => m.default),
    add: () => import('./commands/add').then(m => m.default),
    restore: () => import('./commands/restore').then(m => m.default),
    repo: () => import('./commands/repo/index').then(m => m.default),
    pkg: () => import('./commands/pkg/index').then(m => m.default),
    reset: () => import('./commands/reset').then(m => m.default),
    doctor: () => import('./commands/doctor').then(m => m.default),
    check: () => import('./commands/check').then(m => m.default),
    listen: () => import('./commands/listen').then(m => m.default),
    hooks: () => import('./commands/hooks/index').then(m => m.default),
  },
  async setup() {
    await ensurepkglabDirs();
  },
});

// runMain handles --help (including nested subcommands), --version, and CLIError natively.
// We wrap it to catch our own error classes thrown from command handlers.
try {
  await runMain(cmd);
} catch (error) {
  if (error instanceof SilentExitError) {
    process.exit(error.exitCode);
  }
  if (error instanceof CommandError) {
    if (!error.logged) {
      log.error(error.message);
    }
    process.exit(1);
  }
  if (error instanceof pkglabError) {
    log.error(error.message);
    process.exit(1);
  }
  throw error;
}
