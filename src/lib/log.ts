import pino from 'pino';

import { c } from './color';

// Custom level for success (31 to avoid collision with info=30)
const customLevels = { success: 31 } as const;

function isTTY(): boolean {
  return typeof process.stdout?.isTTY === 'boolean' && process.stdout.isTTY;
}

function getFormat(): 'pretty' | 'json' {
  const env = process.env.PKGLAB_LOG_FORMAT;
  if (env === 'json') return 'json';
  if (env === 'pretty') return 'pretty';
  return isTTY() ? 'pretty' : 'json';
}

function buildPrettyTransport() {
  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      messageFormat: '{msg}',
      customPrettifiers: {},
    },
  };
}

function createPinoLogger(opts?: { destination?: pino.DestinationStream }) {
  const format = getFormat();
  const baseOpts: pino.LoggerOptions = {
    customLevels,
    level: 'debug',
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (format === 'pretty' && !opts?.destination) {
    // Pretty format with colored prefixes, bypass pino-pretty for simpler output
    // that matches the current CLI look
    return pino({
      ...baseOpts,
      transport: buildPrettyTransport(),
    });
  }

  if (opts?.destination) {
    return pino(baseOpts, opts.destination);
  }

  return pino(baseOpts);
}

/**
 * Create a pino logger for special cases (e.g., daemon log file).
 */
export function createLogger(opts?: { destination?: pino.DestinationStream }) {
  return createPinoLogger(opts);
}

// Use a wrapper that preserves the original CLI aesthetic in pretty mode.
// The raw pino instance is used for structured JSON output in non-TTY mode.
const pinoInstance = createPinoLogger();

type LogFn = (msg: string) => void;

interface PkglabLogger {
  info: LogFn;
  success: LogFn;
  warn: LogFn;
  error: LogFn;
  dim: LogFn;
  line: LogFn;
  child: (bindings: Record<string, unknown>) => PkglabLogger;
  pino: pino.Logger;
}

function makePrettyLogger(pinoInst: pino.Logger): PkglabLogger {
  return {
    info: (msg: string) => console.log(c.blue('info'), msg),
    success: (msg: string) => console.log(c.green('ok'), msg),
    warn: (msg: string) => console.log(c.yellow('warn'), msg),
    error: (msg: string) => console.error(c.red('error'), msg),
    dim: (msg: string) => console.log(c.dim(msg)),
    line: (msg: string) => console.log(msg),
    child(bindings: Record<string, unknown>): PkglabLogger {
      return makePrettyLogger(pinoInst.child(bindings));
    },
    pino: pinoInst,
  };
}

function makeStructuredLogger(pinoInst: pino.Logger): PkglabLogger {
  return {
    info: (msg: string) => pinoInst.info(msg),
    success: (msg: string) => (pinoInst as any).success(msg),
    warn: (msg: string) => pinoInst.warn(msg),
    error: (msg: string) => pinoInst.error(msg),
    dim: (msg: string) => pinoInst.debug(msg),
    line: (msg: string) => pinoInst.info(msg),
    child(bindings: Record<string, unknown>): PkglabLogger {
      return makeStructuredLogger(pinoInst.child(bindings));
    },
    pino: pinoInst,
  };
}

function makeLogger(pinoInst: pino.Logger): PkglabLogger {
  if (getFormat() === 'pretty') {
    return makePrettyLogger(pinoInst);
  }
  return makeStructuredLogger(pinoInst);
}

export const log: PkglabLogger = makeLogger(pinoInstance);
