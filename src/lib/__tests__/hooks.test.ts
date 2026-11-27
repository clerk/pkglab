import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPreHook, trustHooks } from '../hooks';

const repo = await mkdtemp(join(tmpdir(), 'pkglab-hooks-'));
afterAll(() => rm(repo, { recursive: true, force: true }));

const ctx = { event: 'add' as const, packages: [], tag: null, repoPath: repo, registryUrl: '', packageManager: 'npm' };
const hooksDir = join(repo, '.pkglab', 'hooks');

test('hooks only run after trust, and any edit in the hooks folder needs re-trust', async () => {
  await Bun.write(join(hooksDir, 'pre-add.sh'), '. "$(dirname "$0")/helper.sh"\n');
  await Bun.write(join(hooksDir, 'helper.sh'), 'exit 0\n');
  expect((await runPreHook(ctx)).status).toBe('not_found');

  await trustHooks(repo);
  expect((await runPreHook(ctx)).status).toBe('ok');

  // Only the helper changes; the hook entrypoint is untouched
  await Bun.write(join(hooksDir, 'helper.sh'), 'exit 1\n');
  expect((await runPreHook(ctx)).status).toBe('not_found');
});
