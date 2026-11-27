import { homedir } from 'node:os';
import { join } from 'node:path';

// PKGLAB_HOME lets unit tests use a throwaway dir instead of the real ~/.pkglab
const pkglab_HOME = process.env.PKGLAB_HOME || join(homedir(), '.pkglab');
// Logs live under ~/.pkglab, not a shared tmp dir another local user could pre-create.
const pkglab_LOG_DIR = join(pkglab_HOME, 'logs');

export const paths = {
  home: pkglab_HOME,
  config: join(pkglab_HOME, 'config.json'),
  pid: join(pkglab_HOME, 'pid'),
  token: join(pkglab_HOME, 'token'),
  trustedHooks: join(pkglab_HOME, 'trusted-hooks.json'),
  publishLock: join(pkglab_HOME, 'publish.lock'),
  reposDir: join(pkglab_HOME, 'repos'),
  registryDir: join(pkglab_HOME, 'registry'),
  registryStorage: join(pkglab_HOME, 'registry', 'storage'),
  listenersDir: join(pkglab_HOME, 'listeners'),
  fingerprintsDir: join(pkglab_HOME, 'fingerprints'),
  daemonLock: join(pkglab_HOME, 'daemon.lock'),
  listenerLock: join(pkglab_HOME, 'listener.lock'),
  logFile: join(pkglab_LOG_DIR, 'registry.log'),
  logDir: pkglab_LOG_DIR,
} as const;
