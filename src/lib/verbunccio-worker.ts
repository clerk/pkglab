import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import pino from 'pino';

import { loadConfig, ensurepkglabDirs } from './config';
import { paths } from './paths';
import { setLogDestination } from './publish-queue';
import VerbunccioStorage from './verbunccio-storage';
import { handleRequest } from './verbunccio-routes';

export async function main() {
  await ensurepkglabDirs();
  await mkdir(paths.registryStorage, { recursive: true });

  const config = await loadConfig();
  const storage = new VerbunccioStorage();
  await storage.loadAll();

  Bun.serve({
    port: config.port,
    hostname: '127.0.0.1',
    fetch(req) {
      return handleRequest(req, storage, config.port);
    },
  });

  process.stdout.write('READY\n');

  // Create a pino logger that writes JSON Lines to the log file
  // so `pkglab logs -f` can tail registry events (pings, publishes, etc.)
  mkdirSync(dirname(paths.logFile), { recursive: true });
  const dest = pino.destination({ dest: paths.logFile, append: true, sync: true });
  const fileLogger = pino(
    {
      level: 'debug',
      formatters: {
        level(label: string) {
          return { level: label };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );

  setLogDestination(fileLogger, dest);

  // Redirect console output to the file logger
  console.log = (...args: unknown[]) => fileLogger.info(args.map(String).join(' '));
  console.error = (...args: unknown[]) => fileLogger.error(args.map(String).join(' '));
}

// Self-execute when run directly (dev mode)
if (import.meta.main) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
