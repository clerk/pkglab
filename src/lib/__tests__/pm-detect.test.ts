import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectPackageManager } from '../pm-detect';

const root = await mkdtemp(join(tmpdir(), 'pkglab-pm-detect-'));
afterAll(() => rm(root, { recursive: true, force: true }));

async function fixture(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await Bun.write(join(dir, rel), content);
  }
  return dir;
}

describe('detectPackageManager', () => {
  test('uses packageManager field without a lockfile', async () => {
    const dir = await fixture('field-only', { 'package.json': '{"packageManager":"pnpm@10.1.0+sha512.abc"}' });
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });

  test('packageManager field wins over a lockfile in the same dir', async () => {
    const dir = await fixture('field-vs-lock', {
      'package.json': '{"packageManager":"pnpm@10.1.0"}',
      'package-lock.json': '{}',
    });
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });

  test('finds packageManager field in a parent dir', async () => {
    const dir = await fixture('parent-field', {
      'package.json': '{"packageManager":"yarn@4.0.0"}',
      'apps/web/package.json': '{"name":"web"}',
    });
    expect(await detectPackageManager(join(dir, 'apps/web'))).toBe('yarn');
  });

  test('ignores unknown packageManager values and falls back to lockfile', async () => {
    const dir = await fixture('unknown-field', {
      'package.json': '{"packageManager":"deno@2.0.0"}',
      'bun.lock': '',
    });
    expect(await detectPackageManager(dir)).toBe('bun');
  });
});
