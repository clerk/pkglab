import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import type VerbunccioStorage from '../verbunccio-storage';

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

      fetchSpy
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(okJson(packument));

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
