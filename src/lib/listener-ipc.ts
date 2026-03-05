import { join } from 'node:path';

import { ListenerNotRunningError } from './errors';
import { paths } from './paths';

export interface PingMessage {
  names: string[];
  tag?: string;
  root?: boolean;
  force?: boolean;
  single?: boolean;
  shallow?: boolean;
  dryRun?: boolean;
}

export interface PingAck {
  ok: boolean;
  error?: string;
}

/**
 * Get the Unix domain socket path for a workspace's listener.
 * Each workspace gets a unique socket based on a hash of its root path.
 */
export function getListenerSocketPath(workspaceRoot: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(workspaceRoot);
  const hash = hasher.digest('hex').slice(0, 12);
  return join(paths.listenersDir, `${hash}.sock`);
}

/**
 * Send a ping message to a running listener and wait for acknowledgement.
 * Throws ListenerNotRunningError if no listener is running at the socket.
 */
export async function sendPing(socketPath: string, message: PingMessage): Promise<PingAck> {
  return new Promise<PingAck>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const timeout = setTimeout(() => {
      settle(() => reject(new ListenerNotRunningError()));
    }, 3000);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          const payload = JSON.stringify(message) + '\n';
          socket.write(payload);
          socket.flush();
        },
        data(_socket, data) {
          buffer += data.toString();
          const newlineIdx = buffer.indexOf('\n');
          if (newlineIdx !== -1) {
            const line = buffer.slice(0, newlineIdx);
            clearTimeout(timeout);
            try {
              const ack = JSON.parse(line) as PingAck;
              if (ack.ok) {
                settle(() => resolve(ack));
              } else {
                settle(() => reject(new Error(ack.error ?? 'Listener rejected the ping')));
              }
            } catch {
              settle(() => reject(new Error('Invalid ack from listener')));
            }
            _socket.end();
          }
        },
        error(_socket, error) {
          clearTimeout(timeout);
          settle(() => reject(new ListenerNotRunningError()));
          void error;
        },
        close() {
          clearTimeout(timeout);
          // If we haven't settled yet, the connection closed before we got a response
          settle(() => reject(new ListenerNotRunningError()));
        },
        connectError(_socket, error) {
          clearTimeout(timeout);
          settle(() => reject(new ListenerNotRunningError()));
          void error;
        },
      },
    }).catch(() => {
      clearTimeout(timeout);
      settle(() => reject(new ListenerNotRunningError()));
    });
  });
}

export function getListenerPidPath(workspaceRoot: string): string {
  return getListenerSocketPath(workspaceRoot).replace(/\.sock$/, '.pid');
}

export function getListenerLockPath(workspaceRoot: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
  return join(paths.listenersDir, `${hash}.lock`);
}

export function getListenerLogPath(workspaceRoot: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
  return join('/tmp/pkglab', `listener-${hash}.log`);
}

/**
 * Check if a listener is running and connectable at the given socket path.
 */
export async function isListenerRunning(socketPath: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false;

    const settle = (value: boolean) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const timeout = setTimeout(() => {
      settle(false);
    }, 1000);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          clearTimeout(timeout);
          socket.end();
          settle(true);
        },
        error() {
          clearTimeout(timeout);
          settle(false);
        },
        data() {},
        close() {
          clearTimeout(timeout);
        },
        connectError() {
          clearTimeout(timeout);
          settle(false);
        },
      },
    }).catch(() => {
      clearTimeout(timeout);
      settle(false);
    });
  });
}
