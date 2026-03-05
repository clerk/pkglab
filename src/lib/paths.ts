import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const pkglab_HOME = join(homedir(), '.pkglab');
const pkglab_LOG_DIR = join(tmpdir(), `pkglab-${process.getuid?.() ?? 'default'}`);

export const paths = {
  home: pkglab_HOME,
  config: join(pkglab_HOME, 'config.json'),
  pid: join(pkglab_HOME, 'pid'),
  publishLock: join(pkglab_HOME, 'publish.lock'),
  reposDir: join(pkglab_HOME, 'repos'),
  registryDir: join(pkglab_HOME, 'registry'),
  registryStorage: join(pkglab_HOME, 'registry', 'storage'),
  listenersDir: join(pkglab_HOME, 'listeners'),
  daemonLock: join(pkglab_HOME, 'daemon.lock'),
  listenerLock: join(pkglab_HOME, 'listener.lock'),
  logFile: join(pkglab_LOG_DIR, 'registry.log'),
  logDir: pkglab_LOG_DIR,
} as const;
