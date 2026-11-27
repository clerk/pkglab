import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type VerbunccioStorage from '../verbunccio-storage';

import { registryToken } from '../registry';
import { handleRequest } from '../verbunccio-routes';

const PORT = 16180;

const fetchSpy = spyOn(globalThis, 'fetch');

afterEach(() => {
  fetchSpy.mockReset();
});

// Minimal mock — reports no local packages so all GETs proxy upstream
function createMockStorage(): VerbunccioStorage {
  return {
    hasPackage: () => false,
  } as unknown as VerbunccioStorage;
}

function createRequest(path: string, method = 'GET'): Request {
  return new Request(`http://127.0.0.1:${PORT}${path}`, { method });
}

function okJson(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('proxyToUpstream', () => {
  describe('JSON packument responses', () => {
    test('proxies valid JSON packument from upstream', async () => {
      const packument = { name: 'lodash', versions: { '4.17.21': {} } };
      fetchSpy.mockResolvedValueOnce(okJson(packument));

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/lodash'), storage, PORT);

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.name).toBe('lodash');
    });

    test('retries on corrupted JSON and succeeds on second attempt', async () => {
      const packument = { name: 'typescript', versions: { '5.0.0': {} } };

      fetchSpy
        .mockResolvedValueOnce(
          new Response('{"name":"typescript","versions":{', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(okJson(packument));

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/typescript'), storage, PORT);

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.name).toBe('typescript');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    test('returns 502 after exhausting retries on corrupted JSON', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response('{"name":"truncated', { status: 200, headers: { 'content-type': 'application/json' } }),
        )
        .mockResolvedValueOnce(
          new Response('{"name":"truncated', { status: 200, headers: { 'content-type': 'application/json' } }),
        )
        .mockResolvedValueOnce(
          new Response('{"name":"truncated', { status: 200, headers: { 'content-type': 'application/json' } }),
        );

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/typescript'), storage, PORT);

      expect(resp.status).toBe(502);
      const body = await resp.json();
      expect(body.error).toBe('bad_gateway');
    });

    test('retries on network error and succeeds on second attempt', async () => {
      const packument = { name: 'react', versions: { '18.0.0': {} } };

      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(okJson(packument));

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/react'), storage, PORT);

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.name).toBe('react');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    test('returns 502 after exhausting retries on network errors', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/react'), storage, PORT);

      expect(resp.status).toBe(502);
      const body = await resp.json();
      expect(body.error).toBe('bad_gateway');
    });

    test('does not retry on valid non-200 response', async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ error: 'not_found' }, { status: 404 }));

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/nonexistent-pkg'), storage, PORT);

      expect(resp.status).toBe(404);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    test('passes through empty body on non-ok response without validation', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 404 }));

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/bad-pkg'), storage, PORT);

      expect(resp.status).toBe(404);
      expect(await resp.text()).toBe('');
    });
  });

  describe('tarball responses', () => {
    test('streams tarball directly without JSON validation', async () => {
      const tarballData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
      fetchSpy.mockResolvedValueOnce(
        new Response(tarballData, {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );

      const storage = createMockStorage();
      // Tarballs go through handleGetTarball -> proxyToUpstream when not stored locally
      (storage as any).getTarballPath = () => '/nonexistent/path';
      const resp = await handleRequest(createRequest('/lodash/-/lodash-4.17.21.tgz'), storage, PORT);

      expect(resp.status).toBe(200);
    });
  });

  describe('header handling', () => {
    test('strips content-encoding and content-length from proxied response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ name: 'lodash' }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '12345',
          },
        }),
      );

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/lodash'), storage, PORT);

      expect(resp.headers.get('content-encoding')).toBeNull();
      expect(resp.headers.get('content-length')).toBeNull();
    });

    test('strips authorization header before proxying to upstream', async () => {
      fetchSpy.mockResolvedValueOnce(okJson({ name: 'lodash' }));

      const storage = createMockStorage();
      const req = new Request(`http://127.0.0.1:${PORT}/lodash`, {
        headers: { authorization: 'Bearer secret-token' },
      });
      await handleRequest(req, storage, PORT);

      const calledInit = fetchSpy.mock.calls[0][1] as RequestInit;
      const sentHeaders = new Headers(calledInit.headers);
      expect(sentHeaders.get('authorization')).toBeNull();
    });
  });
});

describe('write protection', () => {
  const auth = () => ({ authorization: `Bearer ${registryToken()}`, 'content-type': 'application/json' });
  const publishBody = (version: string, attachment: string) =>
    JSON.stringify({
      versions: { [version]: { name: 'left-pad', version } },
      _attachments: { [attachment]: { data: Buffer.from('tarball').toString('base64') } },
    });

  test('rejects foreign Host (DNS rebinding)', async () => {
    const resp = await handleRequest(new Request(`http://evil.example:${PORT}/lodash`), createMockStorage(), PORT);
    expect(resp.status).toBe(403);
  });

  test('rejects cross-site text/plain publish-queue POST without token', async () => {
    const req = new Request(`http://127.0.0.1:${PORT}/-/pkglab/publish`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ workspaceRoot: '/', targets: [], root: true }),
    });
    expect((await handleRequest(req, createMockStorage(), PORT)).status).toBe(401);
  });

  test('rejects publish without token', async () => {
    const req = new Request(`http://127.0.0.1:${PORT}/left-pad`, {
      method: 'PUT',
      body: publishBody('0.0.0-pkglab.1', 'left-pad-0.0.0-pkglab.1.tgz'),
    });
    expect((await handleRequest(req, createMockStorage(), PORT)).status).toBe(401);
  });

  test('rejects non-pkglab versions even with token', async () => {
    const req = new Request(`http://127.0.0.1:${PORT}/left-pad`, {
      method: 'PUT',
      headers: auth(),
      body: publishBody('1.3.0', 'left-pad-1.3.0.tgz'),
    });
    expect((await handleRequest(req, createMockStorage(), PORT)).status).toBe(400);
  });

  test('rejects attachment named for another version', async () => {
    const req = new Request(`http://127.0.0.1:${PORT}/left-pad`, {
      method: 'PUT',
      headers: auth(),
      body: publishBody('0.0.0-pkglab.2', 'left-pad-0.0.0-pkglab.1.tgz'),
    });
    expect((await handleRequest(req, createMockStorage(), PORT)).status).toBe(400);
  });

  test('rejects publish-queue targets that look like flags', async () => {
    const req = new Request(`http://127.0.0.1:${PORT}/-/pkglab/publish`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ workspaceRoot: '/', targets: ['--__prune'] }),
    });
    expect((await handleRequest(req, createMockStorage(), PORT)).status).toBe(400);
  });
});

describe('unpublish via -rev', () => {
  test('accepts an upstream-merged body and only removes pkglab versions', async () => {
    const existing = {
      _id: 'left-pad',
      _rev: '3-verbunccio',
      name: 'left-pad',
      'dist-tags': { pkglab: '0.0.0-pkglab.2' },
      versions: { '0.0.0-pkglab.1': {}, '0.0.0-pkglab.2': {} },
      time: {},
    };
    let saved: any;
    const storage = {
      withLock: (_: string, fn: () => unknown) => fn(),
      getPackument: () => existing,
      savePackument: (_: string, doc: unknown) => {
        saved = doc;
      },
      deleteTarball: () => {},
    } as unknown as VerbunccioStorage;
    // Body as unpublishVersions builds it from GET: upstream versions merged in, oldest pkglab version removed
    const body = { ...existing, versions: { '1.3.0': {}, '0.0.0-pkglab.2': {} } };
    const req = new Request(`http://127.0.0.1:${PORT}/left-pad/-rev/3-verbunccio`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${registryToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const resp = await handleRequest(req, storage, PORT);
    expect(resp.status).toBe(201);
    expect(Object.keys(saved.versions)).toEqual(['0.0.0-pkglab.2']);
  });
});
