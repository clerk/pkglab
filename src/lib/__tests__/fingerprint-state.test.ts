import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  saveFingerprintState,
  loadFingerprintState,
  fingerprintPath,
  inspectFingerprints,
} from '../fingerprint-state';
import { atomicWrite } from '../fs';
import { paths } from '../paths';

// Use a temp directory for fingerprints during tests
let originalFingerprintsDir: string;
let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `pkglab-fp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tempDir, { recursive: true });
  originalFingerprintsDir = paths.fingerprintsDir;
  // Override the paths object for testing
  (paths as { fingerprintsDir: string }).fingerprintsDir = tempDir;
});

afterEach(async () => {
  (paths as { fingerprintsDir: string }).fingerprintsDir = originalFingerprintsDir;
  await rm(tempDir, { recursive: true, force: true });
});

describe('saveFingerprintState', () => {
  test('writes __meta__ with workspaceRoot and updatedAt', async () => {
    const workspaceRoot = '/tmp/test-workspace';
    await saveFingerprintState(workspaceRoot, null, [
      { name: '@scope/pkg', hash: 'abc123', version: '0.0.0-pkglab.1' },
    ]);

    const filePath = fingerprintPath(workspaceRoot);
    const data = await Bun.file(filePath).json();
    expect(data.__meta__).toBeDefined();
    expect(data.__meta__.workspaceRoot).toBe(workspaceRoot);
    expect(typeof data.__meta__.updatedAt).toBe('string');
    // Should be a valid ISO timestamp
    expect(new Date(data.__meta__.updatedAt).toISOString()).toBe(data.__meta__.updatedAt);
  });

  test('preserves package data alongside __meta__', async () => {
    const workspaceRoot = '/tmp/test-workspace';
    await saveFingerprintState(workspaceRoot, null, [
      { name: '@scope/pkg', hash: 'abc123', version: '0.0.0-pkglab.1' },
    ]);

    const filePath = fingerprintPath(workspaceRoot);
    const data = await Bun.file(filePath).json();
    expect(data['@scope/pkg']).toBeDefined();
    expect(data['@scope/pkg'].__untagged__).toEqual({
      hash: 'abc123',
      version: '0.0.0-pkglab.1',
    });
  });

  test('updates __meta__.updatedAt on subsequent saves', async () => {
    const workspaceRoot = '/tmp/test-workspace';
    await saveFingerprintState(workspaceRoot, null, [
      { name: '@scope/pkg', hash: 'abc123', version: '0.0.0-pkglab.1' },
    ]);

    const filePath = fingerprintPath(workspaceRoot);
    const first = await Bun.file(filePath).json();
    const firstDate = first.__meta__.updatedAt;

    // Small delay to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    await saveFingerprintState(workspaceRoot, null, [
      { name: '@scope/pkg', hash: 'def456', version: '0.0.0-pkglab.2' },
    ]);

    const second = await Bun.file(filePath).json();
    expect(second.__meta__.updatedAt).not.toBe(firstDate);
  });
});

describe('loadFingerprintState', () => {
  test('skips __meta__ key when loading packages', async () => {
    const workspaceRoot = '/tmp/test-workspace';
    await saveFingerprintState(workspaceRoot, null, [
      { name: '@scope/pkg', hash: 'abc123', version: '0.0.0-pkglab.1' },
    ]);

    const state = await loadFingerprintState(workspaceRoot, null);
    expect(state['__meta__']).toBeUndefined();
    expect(state['@scope/pkg']).toEqual({
      hash: 'abc123',
      version: '0.0.0-pkglab.1',
    });
  });

  test('handles files with __meta__ and multiple packages', async () => {
    const workspaceRoot = '/tmp/test-workspace';
    await saveFingerprintState(workspaceRoot, null, [
      { name: '@scope/a', hash: 'aaa', version: '0.0.0-pkglab.1' },
      { name: '@scope/b', hash: 'bbb', version: '0.0.0-pkglab.2' },
    ]);

    const state = await loadFingerprintState(workspaceRoot, null);
    expect(Object.keys(state)).toEqual(['@scope/a', '@scope/b']);
  });

  test('handles files without __meta__ (pre-existing data)', async () => {
    const workspaceRoot = '/tmp/test-workspace';
    const filePath = fingerprintPath(workspaceRoot);
    await mkdir(tempDir, { recursive: true });
    // Write a file without __meta__
    await atomicWrite(
      filePath,
      JSON.stringify({
        '@scope/pkg': { __untagged__: { hash: 'abc', version: '0.0.0-pkglab.1' } },
      }) + '\n',
    );

    const state = await loadFingerprintState(workspaceRoot, null);
    expect(state['@scope/pkg']).toEqual({ hash: 'abc', version: '0.0.0-pkglab.1' });
  });
});

describe('inspectFingerprints', () => {
  test('returns zeros when fingerprints dir is empty', async () => {
    const result = await inspectFingerprints({ prune: false });
    expect(result).toEqual({ total: 0, stale: 0, legacy: 0, pruned: 0 });
  });

  test('counts legacy files (no __meta__)', async () => {
    const filePath = join(tempDir, 'abc123.json');
    await atomicWrite(
      filePath,
      JSON.stringify({
        '@scope/pkg': { __untagged__: { hash: 'abc', version: '0.0.0-pkglab.1' } },
      }) + '\n',
    );

    const result = await inspectFingerprints({ prune: false });
    expect(result.total).toBe(1);
    expect(result.legacy).toBe(1);
    expect(result.stale).toBe(0);
  });

  test('counts stale files (workspace directory missing)', async () => {
    const filePath = join(tempDir, 'abc123.json');
    await atomicWrite(
      filePath,
      JSON.stringify({
        __meta__: { workspaceRoot: '/nonexistent/path/that/does/not/exist', updatedAt: new Date().toISOString() },
        '@scope/pkg': { __untagged__: { hash: 'abc', version: '0.0.0-pkglab.1' } },
      }) + '\n',
    );

    const result = await inspectFingerprints({ prune: false });
    expect(result.total).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.pruned).toBe(0);
  });

  test('prunes stale files when prune: true', async () => {
    const filePath = join(tempDir, 'abc123.json');
    await atomicWrite(
      filePath,
      JSON.stringify({
        __meta__: { workspaceRoot: '/nonexistent/path/that/does/not/exist', updatedAt: new Date().toISOString() },
        '@scope/pkg': { __untagged__: { hash: 'abc', version: '0.0.0-pkglab.1' } },
      }) + '\n',
    );

    const result = await inspectFingerprints({ prune: true });
    expect(result.total).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.pruned).toBe(1);

    // File should be deleted
    const remaining = await readdir(tempDir);
    expect(remaining.filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  test('does not prune valid files', async () => {
    // Use a directory that exists (tempDir itself)
    const filePath = join(tempDir, 'abc123.json');
    await atomicWrite(
      filePath,
      JSON.stringify({
        __meta__: { workspaceRoot: tempDir, updatedAt: new Date().toISOString() },
        '@scope/pkg': { __untagged__: { hash: 'abc', version: '0.0.0-pkglab.1' } },
      }) + '\n',
    );

    const result = await inspectFingerprints({ prune: true });
    expect(result.total).toBe(1);
    expect(result.stale).toBe(0);
    expect(result.pruned).toBe(0);

    // File should still exist
    const remaining = await readdir(tempDir);
    expect(remaining.filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  test('skips non-json files', async () => {
    await Bun.write(join(tempDir, 'readme.txt'), 'not a fingerprint file');

    const result = await inspectFingerprints({ prune: false });
    expect(result.total).toBe(0);
  });

  test('handles corrupted json files as legacy', async () => {
    await Bun.write(join(tempDir, 'corrupted.json'), 'not valid json{{{');

    const result = await inspectFingerprints({ prune: false });
    expect(result.total).toBe(1);
    expect(result.legacy).toBe(1);
  });

  test('returns zeros when fingerprints dir does not exist', async () => {
    (paths as { fingerprintsDir: string }).fingerprintsDir = '/nonexistent/dir/path';
    const result = await inspectFingerprints({ prune: false });
    expect(result).toEqual({ total: 0, stale: 0, legacy: 0, pruned: 0 });
  });

  test('handles mixed files correctly', async () => {
    // Valid file (workspace exists)
    await atomicWrite(
      join(tempDir, 'valid.json'),
      JSON.stringify({
        __meta__: { workspaceRoot: tempDir, updatedAt: new Date().toISOString() },
        '@scope/a': { __untagged__: { hash: 'aaa', version: '0.0.0-pkglab.1' } },
      }) + '\n',
    );

    // Legacy file (no __meta__)
    await atomicWrite(
      join(tempDir, 'legacy.json'),
      JSON.stringify({
        '@scope/b': { __untagged__: { hash: 'bbb', version: '0.0.0-pkglab.2' } },
      }) + '\n',
    );

    // Stale file (workspace gone)
    await atomicWrite(
      join(tempDir, 'stale.json'),
      JSON.stringify({
        __meta__: { workspaceRoot: '/gone/workspace', updatedAt: new Date().toISOString() },
        '@scope/c': { __untagged__: { hash: 'ccc', version: '0.0.0-pkglab.3' } },
      }) + '\n',
    );

    const result = await inspectFingerprints({ prune: false });
    expect(result.total).toBe(3);
    expect(result.legacy).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.pruned).toBe(0);
  });
});
