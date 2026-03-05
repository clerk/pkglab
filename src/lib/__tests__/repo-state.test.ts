import { describe, test, expect } from 'bun:test';

import { repoFileName } from '../repo-state';

describe('repoFileName', () => {
  test('short path produces hash--encoded-path format', () => {
    const result = repoFileName('/Users/nikos/myrepo');
    // Leading slash stripped, inner slashes replaced with dashes
    expect(result).toMatch(/^[a-f0-9]{8}--Users-nikos-myrepo$/);
  });

  test('deterministic: same input always produces the same output', () => {
    const path = '/some/canonical/path';
    const a = repoFileName(path);
    const b = repoFileName(path);
    expect(a).toBe(b);
  });

  test('different inputs produce different outputs', () => {
    const a = repoFileName('/path/one');
    const b = repoFileName('/path/two');
    expect(a).not.toBe(b);
  });

  test('leading slash is stripped from encoded portion', () => {
    const result = repoFileName('/foo');
    // Should not start with a dash after the hash--
    const encoded = result.split('--')[1];
    expect(encoded).toBe('foo');
    expect(encoded).not.toMatch(/^-/);
  });

  test('all slashes are replaced with dashes', () => {
    const result = repoFileName('/a/b/c/d');
    const encoded = result.split('--')[1];
    expect(encoded).toBe('a-b-c-d');
    expect(encoded).not.toContain('/');
  });

  test('path over 50 chars takes last 50 of encoded path', () => {
    // Build a path whose encoded form (after stripping leading / and replacing /) exceeds 50 chars
    // Encoded: "a-very-long-path-segment-that-keeps-going-and-going-and-never-stops-at-all"
    const longPath = '/a/very/long/path/segment/that/keeps/going/and/going/and/never/stops/at/all';
    const result = repoFileName(longPath);
    const encoded = result.split('--')[1];
    expect(encoded.length).toBe(50);

    // The encoded portion should be the last 50 chars of the full encoded string
    const fullEncoded = longPath.replace(/^\//, '').replace(/\//g, '-');
    expect(fullEncoded.length).toBeGreaterThan(50);
    expect(encoded).toBe(fullEncoded.slice(-50));
  });

  test('path with encoded length exactly 50 is not truncated', () => {
    // We need an encoded path of exactly 50 chars
    // Leading slash is stripped, then slashes become dashes
    // "x".repeat(50) with a leading slash gives encoded length 50
    const path = '/' + 'x'.repeat(50);
    const result = repoFileName(path);
    const encoded = result.split('--')[1];
    expect(encoded.length).toBe(50);
    expect(encoded).toBe('x'.repeat(50));
  });

  test('path with encoded length 49 is not truncated', () => {
    const path = '/' + 'x'.repeat(49);
    const result = repoFileName(path);
    const encoded = result.split('--')[1];
    expect(encoded.length).toBe(49);
    expect(encoded).toBe('x'.repeat(49));
  });

  test('path with encoded length 51 is truncated to last 50', () => {
    const path = '/' + 'a' + 'b'.repeat(50);
    const result = repoFileName(path);
    const encoded = result.split('--')[1];
    expect(encoded.length).toBe(50);
    expect(encoded).toBe('b'.repeat(50));
  });

  test('hash is 8-char hex prefix of SHA-256', () => {
    const result = repoFileName('/test/path');
    const hash = result.split('--')[0];
    expect(hash).toMatch(/^[a-f0-9]{8}$/);
  });
});
