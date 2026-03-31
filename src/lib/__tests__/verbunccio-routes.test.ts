import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { handleRequest } from '../verbunccio-routes';
import type VerbunccioStorage from '../verbunccio-storage';

const UPSTREAM = 'https://registry.npmjs.org';
const PORT = 16180;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Minimal mock — reports no local packages so all GETs proxy upstream
function createMockStorage(): VerbunccioStorage {
  return {
    hasPackage: () => false,
  } as unknown as VerbunccioStorage;
}

function createRequest(path: string, method = 'GET'): Request {
  return new Request(`http://127.0.0.1:${PORT}${path}`, { method });
}

describe('proxyToUpstream', () => {
  describe('JSON packument responses', () => {
    test('proxies valid JSON packument from upstream', async () => {
      const packument = { name: 'lodash', versions: { '4.17.21': {} } };
      server.use(http.get(`${UPSTREAM}/lodash`, () => HttpResponse.json(packument)));

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/lodash'), storage, PORT);

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.name).toBe('lodash');
    });

    test('retries on corrupted JSON and succeeds on second attempt', async () => {
      let attempt = 0;
      const packument = { name: 'typescript', versions: { '5.0.0': {} } };

      server.use(
        http.get(`${UPSTREAM}/typescript`, () => {
          attempt++;
          if (attempt === 1) {
            // Return truncated/corrupted JSON
            return new HttpResponse('{"name":"typescript","versions":{', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return HttpResponse.json(packument);
        }),
      );

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/typescript'), storage, PORT);

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.name).toBe('typescript');
      expect(attempt).toBe(2);
    });

    test('returns 502 after exhausting retries on corrupted JSON', async () => {
      server.use(
        http.get(`${UPSTREAM}/typescript`, () => {
          return new HttpResponse('{"name":"truncated', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/typescript'), storage, PORT);

      expect(resp.status).toBe(502);
      const body = await resp.json();
      expect(body.error).toBe('bad_gateway');
    });

    test('retries on network error and succeeds on second attempt', async () => {
      let attempt = 0;
      const packument = { name: 'react', versions: { '18.0.0': {} } };

      server.use(
        http.get(`${UPSTREAM}/react`, () => {
          attempt++;
          if (attempt === 1) {
            return HttpResponse.error();
          }
          return HttpResponse.json(packument);
        }),
      );

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/react'), storage, PORT);

      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.name).toBe('react');
      expect(attempt).toBe(2);
    });

    test('returns 502 after exhausting retries on network errors', async () => {
      server.use(http.get(`${UPSTREAM}/react`, () => HttpResponse.error()));

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/react'), storage, PORT);

      expect(resp.status).toBe(502);
      const body = await resp.json();
      expect(body.error).toBe('bad_gateway');
    });

    test('does not retry on valid non-200 response', async () => {
      let attempt = 0;

      server.use(
        http.get(`${UPSTREAM}/nonexistent-pkg`, () => {
          attempt++;
          return HttpResponse.json({ error: 'not_found' }, { status: 404 });
        }),
      );

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/nonexistent-pkg'), storage, PORT);

      expect(resp.status).toBe(404);
      expect(attempt).toBe(1);
    });

    test('passes through empty body on non-ok response without validation', async () => {
      server.use(
        http.get(`${UPSTREAM}/bad-pkg`, () => {
          return new HttpResponse('', { status: 404 });
        }),
      );

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/bad-pkg'), storage, PORT);

      expect(resp.status).toBe(404);
      expect(await resp.text()).toBe('');
    });
  });

  describe('tarball responses', () => {
    test('streams tarball directly without JSON validation', async () => {
      const tarballData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);

      server.use(
        http.get(`${UPSTREAM}/lodash/-/lodash-4.17.21.tgz`, () => {
          return new HttpResponse(tarballData, {
            headers: { 'content-type': 'application/octet-stream' },
          });
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
      server.use(
        http.get(`${UPSTREAM}/lodash`, () => {
          return HttpResponse.json(
            { name: 'lodash' },
            {
              headers: {
                'content-encoding': 'gzip',
                'content-length': '12345',
              },
            },
          );
        }),
      );

      const storage = createMockStorage();
      const resp = await handleRequest(createRequest('/lodash'), storage, PORT);

      expect(resp.headers.get('content-encoding')).toBeNull();
      expect(resp.headers.get('content-length')).toBeNull();
    });

    test('strips authorization header before proxying to upstream', async () => {
      let receivedHeaders: Headers | undefined;

      server.use(
        http.get(`${UPSTREAM}/lodash`, ({ request }) => {
          receivedHeaders = request.headers;
          return HttpResponse.json({ name: 'lodash' });
        }),
      );

      const storage = createMockStorage();
      const req = new Request(`http://127.0.0.1:${PORT}/lodash`, {
        headers: { authorization: 'Bearer secret-token' },
      });
      await handleRequest(req, storage, PORT);

      expect(receivedHeaders?.get('authorization')).toBeNull();
    });
  });
});
