import { pkglabError } from './errors';

export interface PublishPingMessage {
  workspaceRoot: string;
  targets: string[];
  tag?: string;
  root?: boolean;
  force?: boolean;
  single?: boolean;
  shallow?: boolean;
  dryRun?: boolean;
}

/**
 * Send a publish request to the registry's built-in publish queue.
 * POST /-/pkglab/publish on 127.0.0.1.
 */
export async function sendPublishRequest(port: number, message: PublishPingMessage): Promise<void> {
  const url = `http://127.0.0.1:${port}/-/pkglab/publish`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new pkglabError('Could not reach the registry. Is it running? Try: pkglab up');
  }

  if (!resp.ok) {
    let reason = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as Record<string, unknown>;
      if (typeof body.reason === 'string') {
        reason = body.reason;
      }
    } catch {
      // ignore parse errors
    }
    throw new pkglabError(`Registry rejected publish request: ${reason}`);
  }
}
