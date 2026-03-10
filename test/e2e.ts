import { mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const projectRoot = resolve(import.meta.dir, '..');
const ENTRY = resolve(projectRoot, 'src/index.ts');

// ── Helpers ──

let passed = 0;
let failed = 0;

async function pkglab(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
    cwd: opts?.cwd ?? projectRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    console.log(`  [cmd: pkglab ${args.join(' ')}] exit=${code}`);
    if (stdout.trim()) {
      console.log(`  stdout: ${stdout.trim()}`);
    }
    if (stderr.trim()) {
      console.log(`  stderr: ${stderr.trim()}`);
    }
  }
  return { stdout, stderr, code };
}

async function readPkgJson(dir: string): Promise<Record<string, any>> {
  return Bun.file(join(dir, 'package.json')).json();
}

function assert(condition: boolean, msg: string, context?: { stdout?: string; stderr?: string }): void {
  if (!condition) {
    console.log(`  FAIL: ${msg}`);
    if (context?.stdout) {
      console.log(`  stdout: ${context.stdout.trim()}`);
    }
    if (context?.stderr) {
      console.log(`  stderr: ${context.stderr.trim()}`);
    }
    failed++;
    throw new Error(msg);
  }
  console.log(`  pass: ${msg}`);
  passed++;
}

function heading(msg: string): void {
  console.log(`\n── ${msg} ──`);
}

async function writeJson(path: string, data: Record<string, any>): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2) + '\n');
}

function getDep(pkgJson: Record<string, any>, name: string): string | undefined {
  return pkgJson.dependencies?.[name] ?? pkgJson.devDependencies?.[name];
}

// ── Setup ──

const testDir = join('/tmp', `pkglab-test-${Date.now()}`);
const producerDir = join(testDir, 'producer');
const consumer1Dir = join(testDir, 'consumer-1');
const consumer2Dir = join(testDir, 'consumer-2');

heading('Setup');
console.log(`  Test dir: ${testDir}`);

// Create directory structure
await mkdir(join(producerDir, 'packages/pkg-a'), { recursive: true });
await mkdir(join(producerDir, 'packages/pkg-b'), { recursive: true });
await mkdir(join(producerDir, 'packages/pkg-c'), { recursive: true });
await mkdir(consumer1Dir, { recursive: true });
await mkdir(consumer2Dir, { recursive: true });

// Producer: workspace root
await writeJson(join(producerDir, 'package.json'), {
  name: 'test-producer',
  private: true,
  workspaces: ['packages/*'],
});

// Producer: pkg-a
await writeJson(join(producerDir, 'packages/pkg-a/package.json'), {
  name: '@test/pkg-a',
  version: '1.0.0',
});

// Producer: pkg-b (depends on pkg-a)
await writeJson(join(producerDir, 'packages/pkg-b/package.json'), {
  name: '@test/pkg-b',
  version: '1.0.0',
  dependencies: { '@test/pkg-a': 'workspace:*' },
});

// Producer: pkg-c (depends on pkg-a, used to test consumer-aware filtering)
await writeJson(join(producerDir, 'packages/pkg-c/package.json'), {
  name: '@test/pkg-c',
  version: '1.0.0',
  dependencies: { '@test/pkg-a': 'workspace:*' },
});

// Consumers: minimal package.json + bun install for lockfile
for (const [dir, name] of [
  [consumer1Dir, 'consumer-1'],
  [consumer2Dir, 'consumer-2'],
] as const) {
  await writeJson(join(dir, 'package.json'), {
    name,
    version: '1.0.0',
    dependencies: {},
  });
  // Create bun lockfile so PM detection picks up bun
  const proc = Bun.spawn(['bun', 'install'], {
    cwd: dir,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  await proc.exited;
}

// Install producer workspace
const prodInstall = Bun.spawn(['bun', 'install'], {
  cwd: producerDir,
  stdout: 'ignore',
  stderr: 'ignore',
});
await prodInstall.exited;

// ── Tests ──

try {
  // 1. Start registry
  heading('1. pkglab up');
  {
    const r = await pkglab(['up']);
    assert(r.code === 0, 'pkglab up succeeds');
  }

  // Give the registry a moment to be ready
  await Bun.sleep(1000);

  // 2. Publish untagged from producer
  heading('2. pkglab pub (untagged)');
  {
    const r = await pkglab(['pub'], { cwd: producerDir });
    assert(r.code === 0, 'pkglab pub succeeds');
  }

  // 3. Add @test/pkg-a to consumer-1 (untagged)
  heading('3. pkglab add @test/pkg-a (consumer-1, untagged)');
  {
    const r = await pkglab(['add', '@test/pkg-a'], { cwd: consumer1Dir });
    assert(r.code === 0, 'pkglab add succeeds');

    const pkg = await readPkgJson(consumer1Dir);
    const ver = getDep(pkg, '@test/pkg-a');
    assert(!!ver, 'consumer-1 has @test/pkg-a in deps');
    assert(ver!.includes('0.0.0-pkglab.'), 'version is untagged pkglab format');
  }

  // 4. Publish tagged (feat1) from producer
  heading('4. pkglab pub -t feat1');
  {
    const r = await pkglab(['pub', '-t', 'feat1'], { cwd: producerDir });
    assert(r.code === 0, 'pkglab pub -t feat1 succeeds');
  }

  // 5. Add @test/pkg-a@feat1 to consumer-2
  heading('5. pkglab add @test/pkg-a@feat1 (consumer-2)');
  {
    const r = await pkglab(['add', '@test/pkg-a@feat1'], { cwd: consumer2Dir });
    assert(r.code === 0, 'pkglab add @test/pkg-a@feat1 succeeds');

    const pkg = await readPkgJson(consumer2Dir);
    const ver = getDep(pkg, '@test/pkg-a');
    assert(!!ver, 'consumer-2 has @test/pkg-a in deps');
    assert(ver!.includes('0.0.0-pkglab-feat1.'), 'version is tagged pkglab-feat1 format');
  }

  // 6. Publish untagged again, verify consumer-1 updated but consumer-2 NOT
  heading('6. Tag isolation: untagged pub');
  {
    // Record current versions
    const c1Before = getDep(await readPkgJson(consumer1Dir), '@test/pkg-a')!;
    const c2Before = getDep(await readPkgJson(consumer2Dir), '@test/pkg-a')!;

    // Touch a file so fingerprinting detects a change
    await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// updated for test 6\n');

    const r = await pkglab(['pub'], { cwd: producerDir });
    assert(r.code === 0, 'pkglab pub (untagged) succeeds');

    const c1After = getDep(await readPkgJson(consumer1Dir), '@test/pkg-a')!;
    const c2After = getDep(await readPkgJson(consumer2Dir), '@test/pkg-a')!;

    assert(c1After !== c1Before, 'consumer-1 (untagged) got updated');
    assert(c2After === c2Before, 'consumer-2 (feat1) was NOT updated');
    assert(c1After.includes('0.0.0-pkglab.'), 'consumer-1 still has untagged version');
  }

  // 7. Publish tagged (feat1) again, verify consumer-2 updated but consumer-1 NOT
  heading('7. Tag isolation: tagged pub');
  {
    const c1Before = getDep(await readPkgJson(consumer1Dir), '@test/pkg-a')!;
    const c2Before = getDep(await readPkgJson(consumer2Dir), '@test/pkg-a')!;

    // Touch a file so fingerprinting detects a change
    await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// updated for test 7\n');

    const r = await pkglab(['pub', '-t', 'feat1'], { cwd: producerDir });
    assert(r.code === 0, 'pkglab pub -t feat1 succeeds');

    const c1After = getDep(await readPkgJson(consumer1Dir), '@test/pkg-a')!;
    const c2After = getDep(await readPkgJson(consumer2Dir), '@test/pkg-a')!;

    assert(c1After === c1Before, 'consumer-1 (untagged) was NOT updated');
    assert(c2After !== c2Before, 'consumer-2 (feat1) got updated');
    assert(c2After.includes('0.0.0-pkglab-feat1.'), 'consumer-2 still has feat1 tag');
  }

  // 8. pkg ls shows both tagged and untagged
  heading('8. pkglab pkg ls');
  {
    const r = await pkglab(['pkg', 'ls']);
    assert(r.code === 0, 'pkglab pkg ls succeeds');

    const out = r.stdout;
    assert(out.includes('@test/pkg-a'), 'output contains @test/pkg-a');
    assert(out.includes('(untagged)'), 'output shows untagged versions');
    assert(out.includes('feat1'), 'output shows feat1 tag');
  }

  // 9. pkglab restore from consumer-1
  heading('9. pkglab restore @test/pkg-a (consumer-1)');
  {
    const r = await pkglab(['restore', '@test/pkg-a'], { cwd: consumer1Dir });
    assert(r.code === 0, 'pkglab restore succeeds');

    const pkg = await readPkgJson(consumer1Dir);
    const ver = getDep(pkg, '@test/pkg-a');
    // Original was empty (added by pkglab), so dep should be removed
    assert(!ver, 'dependency removed after pkglab restore');
  }

  // 10. pkglab check from consumer-2 (should find artifacts)
  heading('10. pkglab check (consumer-2, should find artifacts)');
  {
    const r = await pkglab(['check'], { cwd: consumer2Dir });
    assert(r.code !== 0, 'pkglab check exits non-zero (found artifacts)');
  }

  // 10a. pkglab check detects localhost URLs in staged lockfiles
  heading('10a. pkglab check (lockfile with localhost URLs)');
  {
    // Set up a temporary git repo with a staged bun.lock containing localhost URLs
    const lockfileTestDir = join(testDir, 'lockfile-check');
    await mkdir(lockfileTestDir, { recursive: true });
    await writeJson(join(lockfileTestDir, 'package.json'), {
      name: 'lockfile-check-test',
      version: '1.0.0',
    });

    // Initialize git repo
    const git = (args: string[]) =>
      Bun.spawn(['git', ...args], { cwd: lockfileTestDir, stdout: 'pipe', stderr: 'pipe' });
    await git(['init']).exited;
    await git(['config', 'user.email', 'test@test.com']).exited;
    await git(['config', 'user.name', 'Test']).exited;
    await git(['add', '.']).exited;
    await git(['commit', '-m', 'init']).exited;

    // Write a fake bun.lock with localhost URLs and stage it
    const fakeLock = `{
  "lockfileVersion": 0,
  "packages": {
    "react": ["react@18.2.0", "http://127.0.0.1:16180/react/-/react-18.2.0.tgz", {}, "sha512-abc"],
    "@clerk/shared": ["@clerk/shared@0.0.0-pkglab.123", "http://127.0.0.1:16180/@clerk/shared/-/shared-0.0.0.tgz", {}, "sha512-def"],
    "lodash": ["lodash@4.17.21", "http://localhost:16180/lodash/-/lodash-4.17.21.tgz", {}, "sha512-ghi"]
  }
}`;
    await Bun.write(join(lockfileTestDir, 'bun.lock'), fakeLock);
    await git(['add', 'bun.lock']).exited;

    // check should detect the localhost URLs
    const r = await pkglab(['check'], { cwd: lockfileTestDir });
    assert(r.code !== 0, 'pkglab check exits non-zero for localhost lockfile URLs');
    assert(
      r.stdout.includes('localhost registry URL'),
      'output mentions localhost registry URLs',
      r,
    );
    assert(
      r.stdout.includes('pkglab doctor --lockfile'),
      'output suggests pkglab doctor --lockfile',
      r,
    );
  }

  // 10b. pkglab check passes on clean staged lockfile
  heading('10b. pkglab check (clean lockfile, no localhost URLs)');
  {
    const cleanLockDir = join(testDir, 'lockfile-clean');
    await mkdir(cleanLockDir, { recursive: true });
    await writeJson(join(cleanLockDir, 'package.json'), {
      name: 'lockfile-clean-test',
      version: '1.0.0',
    });

    const git = (args: string[]) =>
      Bun.spawn(['git', ...args], { cwd: cleanLockDir, stdout: 'pipe', stderr: 'pipe' });
    await git(['init']).exited;
    await git(['config', 'user.email', 'test@test.com']).exited;
    await git(['config', 'user.name', 'Test']).exited;
    await git(['add', '.']).exited;
    await git(['commit', '-m', 'init']).exited;

    // Write a clean bun.lock (no localhost URLs) and stage it
    const cleanLock = `{
  "lockfileVersion": 0,
  "packages": {
    "react": ["react@18.2.0", "", {}, "sha512-abc"]
  }
}`;
    await Bun.write(join(cleanLockDir, 'bun.lock'), cleanLock);
    await git(['add', 'bun.lock']).exited;

    const r = await pkglab(['check'], { cwd: cleanLockDir });
    assert(r.code === 0, 'pkglab check passes for clean lockfile', r);
  }

  // 10c. repo reset --all skips missing dirs, reset deletes repo state
  heading('10c. repo reset (missing dirs + cleanup)');
  {
    // consumer-1 was already removed via `pkglab restore`, re-add so we have a repo to reset
    const addR = await pkglab(['add', '@test/pkg-a'], { cwd: consumer1Dir });
    assert(addR.code === 0, 're-add @test/pkg-a to consumer-1');

    // Verify both repos show up
    const lsBefore = await pkglab(['repo', 'ls']);
    assert(lsBefore.stdout.includes('consumer-1'), 'consumer-1 in repo ls');
    assert(lsBefore.stdout.includes('consumer-2'), 'consumer-2 in repo ls');

    // Delete consumer-1 dir to simulate a missing directory
    await rm(consumer1Dir, { recursive: true, force: true });

    // reset --all should auto-prune consumer-1 (missing) and reset consumer-2 (exists)
    const resetR = await pkglab(['repo', 'reset', '--all']);
    assert(resetR.code === 0, 'reset --all succeeds');
    assert(resetR.stdout.includes('automatically pruned'), 'auto-prunes repo with missing dir');
    assert(resetR.stdout.includes('Reset'), 'resets repo with existing dir');

    // Both repos should be gone: consumer-1 was auto-pruned, consumer-2 was reset
    const lsAfter = await pkglab(['repo', 'ls']);
    assert(!lsAfter.stdout.includes('consumer-2'), 'consumer-2 removed after reset');
    assert(!lsAfter.stdout.includes('consumer-1'), 'consumer-1 removed by auto-prune');

    // --stale should find nothing (already cleaned up by auto-prune)
    const staleR = await pkglab(['repo', 'reset', '--stale']);
    assert(staleR.code === 0, 'reset --stale succeeds');
    assert(staleR.stdout.includes('No stale repos'), 'no stale repos after auto-prune');

    // repo ls should be empty
    const lsFinal = await pkglab(['repo', 'ls']);
    assert(lsFinal.stdout.includes('No linked repos'), 'all repos cleaned up');

    // Recreate consumer-1 for remaining tests
    await mkdir(consumer1Dir, { recursive: true });
    await writeJson(join(consumer1Dir, 'package.json'), {
      name: 'consumer-1',
      version: '1.0.0',
      dependencies: {},
    });
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: consumer1Dir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;
  }

  // 10d. pub with deleted active repo auto-prunes instead of crashing
  heading('10d. pub with deleted active repo (auto-prune)');
  {
    // Add @test/pkg-a to both consumers, making them active
    const add1 = await pkglab(['add', '@test/pkg-a'], { cwd: consumer1Dir });
    assert(add1.code === 0, 'add to consumer-1');
    const add2 = await pkglab(['add', '@test/pkg-a'], { cwd: consumer2Dir });
    assert(add2.code === 0, 'add to consumer-2');

    // Delete consumer-2 to simulate a missing repo
    await rm(consumer2Dir, { recursive: true, force: true });

    // pub should succeed, auto-pruning the deleted repo instead of ENOENT
    const pubR = await pkglab(['pub', '--single'], { cwd: producerDir });
    assert(pubR.code === 0, 'pub succeeds despite deleted consumer repo');
    assert(pubR.stdout.includes('automatically pruned'), 'auto-prune message shown during pub');

    // consumer-1 should still get updated
    assert(pubR.stdout.includes('consumer-1'), 'consumer-1 still updated');

    // Restore and recreate consumer-2 for remaining tests
    const restore1 = await pkglab(['restore', '--all'], { cwd: consumer1Dir });
    assert(restore1.code === 0, 'restore consumer-1');
    await mkdir(consumer2Dir, { recursive: true });
    await writeJson(join(consumer2Dir, 'package.json'), {
      name: 'consumer-2',
      version: '1.0.0',
      dependencies: {},
    });
    const bunInit2 = Bun.spawn(['bun', 'install'], {
      cwd: consumer2Dir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit2.exited;
  }

  // 11. Test --worktree flag (from a git repo)
  heading('11. pkglab pub --worktree');
  {
    // Init git in producer so --worktree can detect branch
    for (const cmd of [
      ['git', 'init', '-b', 'feat/test-branch'],
      ['git', 'add', '.'],
      ['git', '-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init', '--allow-empty'],
    ]) {
      const p = Bun.spawn(cmd, { cwd: producerDir, stdout: 'ignore', stderr: 'ignore' });
      await p.exited;
    }

    const r = await pkglab(['pub', '-w'], { cwd: producerDir });
    assert(r.code === 0, 'pkglab pub -w succeeds');

    // Verify the tag was sanitized from feat/test-branch to feat-test-branch
    const lsR = await pkglab(['pkg', 'ls']);
    assert(lsR.stdout.includes('feat-test-branch'), 'worktree tag sanitized correctly');
  }

  // 12. Single-package pub includes deps and cascades to dependents of changed deps
  heading('12. pub single package includes deps but not dependents (no repos)');
  {
    // Touch files so fingerprinting detects changes
    await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// updated for test 12\n');
    await Bun.write(join(producerDir, 'packages/pkg-b/index.js'), '// updated for test 12\n');
    await Bun.write(join(producerDir, 'packages/pkg-c/index.js'), '// updated for test 12\n');

    const r = await pkglab(['pub', '@test/pkg-b'], { cwd: producerDir });
    assert(r.code === 0, 'pkglab pub @test/pkg-b succeeds');
    // pkg-b depends on pkg-a, so pkg-a is in scope as a dependency.
    // No active repos = no dependent expansion, so pkg-c is NOT included.
    assert(r.stdout.includes('@test/pkg-a'), 'dependency @test/pkg-a included in publish');
    assert(r.stdout.includes('@test/pkg-b'), '@test/pkg-b included in publish');
    assert(!r.stdout.includes('\u25B2 @test/pkg-c'), 'pkg-c not published (no active repos)');
    assert(r.stdout.includes('2 packages'), 'publishes 2 packages (target + dep)');
  }

  // 12b. Unchanged dep does NOT cascade to its dependents
  heading('12b. unchanged dep skips cascade');
  {
    // After test 12, pkg-a and pkg-b have fingerprint state.
    // Touch ONLY pkg-b (not pkg-a). Publishing pkg-b should include
    // pkg-a as a dep (unchanged). pkg-c is excluded (no active repos).
    await Bun.write(join(producerDir, 'packages/pkg-b/index.js'), '// updated for test 12b\n');

    const r = await pkglab(['pub', '@test/pkg-b'], { cwd: producerDir });
    assert(r.code === 0, 'pkglab pub @test/pkg-b succeeds');
    assert(r.stdout.includes('@test/pkg-a'), 'dep @test/pkg-a in scope');
    assert(r.stdout.includes('@test/pkg-b'), '@test/pkg-b in scope');
    // pkg-c should NOT be published because pkg-a is unchanged
    assert(!r.stdout.includes('\u25B2 @test/pkg-c'), 'pkg-c not published (dep pkg-a unchanged)');
    assert(r.stdout.includes('1 to publish'), 'only 1 package to publish (pkg-b)');
  }

  // 13. Single-package pub without repos only publishes target
  heading('13. pub single package without repos (no dependents)');
  {
    // pkg-a has no deps. pkg-b and pkg-c depend on it, but with no active repos
    // there's no dependent expansion, so only pkg-a is published.
    await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// updated for test 13\n');

    const r = await pkglab(['pub', '@test/pkg-a'], { cwd: producerDir });
    assert(r.code === 0, 'pkglab pub @test/pkg-a succeeds');
    assert(r.stdout.includes('@test/pkg-a'), '@test/pkg-a included in publish');
    assert(!r.stdout.includes('\u25B2 @test/pkg-b'), 'pkg-b not published (no active repos)');
    assert(!r.stdout.includes('\u25B2 @test/pkg-c'), 'pkg-c not published (no active repos)');
    assert(r.stdout.includes('1 packages'), 'publishes 1 package (target only)');
  }

  // 14. Test error: add with non-existent tag
  heading('14. Error: add with non-existent tag');
  {
    const r = await pkglab(['add', '@test/pkg-a@nonexistent'], { cwd: consumer1Dir });
    assert(r.code !== 0, 'pkglab add with bad tag fails');
  }

  // 15. Test error: --tag and --worktree together
  heading('15. Error: --tag and --worktree together');
  {
    const r = await pkglab(['pub', '-t', 'foo', '-w'], { cwd: producerDir });
    assert(r.code !== 0, 'pub with both --tag and --worktree fails');
  }

  // 16. Consumer-aware cascade filtering
  heading('16. Consumer-aware filtering: skip unconsumed dependents');
  {
    // Publish all so everything has fingerprint state
    await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// updated for test 16 setup\n');
    await Bun.write(join(producerDir, 'packages/pkg-b/index.js'), '// updated for test 16 setup\n');
    await Bun.write(join(producerDir, 'packages/pkg-c/index.js'), '// updated for test 16 setup\n');
    const setup = await pkglab(['pub'], { cwd: producerDir });
    assert(setup.code === 0, 'full pub for test 16 setup');

    // Add only pkg-b to consumer-1 (consumer has pkg-b but NOT pkg-c)
    const addR = await pkglab(['add', '@test/pkg-b'], { cwd: consumer1Dir });
    assert(addR.code === 0, 'add @test/pkg-b to consumer-1');

    // Touch only pkg-a to force a change
    await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// updated for test 16\n');

    // Publish just pkg-a: should cascade to pkg-b (consumed) but skip pkg-c (not consumed)
    const r = await pkglab(['pub', '@test/pkg-a'], { cwd: producerDir });
    assert(r.code === 0, 'pub @test/pkg-a succeeds');
    assert(r.stdout.includes('@test/pkg-a'), 'pkg-a published');
    assert(r.stdout.includes('@test/pkg-b'), 'pkg-b published (consumed dependent)');
    assert(r.stdout.includes('2 packages'), 'only 2 packages published (pkg-c filtered)');
    assert(r.stdout.includes('no consumers'), 'mentions filtered dependents');

    // Clean up: remove pkg-b from consumer
    await pkglab(['restore', '@test/pkg-b'], { cwd: consumer1Dir });
  }

  heading('17. Nested package install with -p flag');
  {
    // Create a bun workspace consumer with apps/web sub-package
    const wsConsumerDir = join(testDir, 'ws-consumer');
    await mkdir(join(wsConsumerDir, 'apps/web'), { recursive: true });

    // Workspace root
    await writeJson(join(wsConsumerDir, 'package.json'), {
      name: 'ws-consumer',
      private: true,
      workspaces: ['apps/*'],
    });

    // Sub-package (include @test/pkg-a so -p can update it)
    await writeJson(join(wsConsumerDir, 'apps/web/package.json'), {
      name: 'web-app',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '0.0.0',
      },
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: wsConsumerDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Add @test/pkg-a targeting the sub-package
    const addR = await pkglab(['add', '@test/pkg-a', '-p', 'apps/web'], { cwd: wsConsumerDir });
    assert(addR.code === 0, 'pkglab add -p apps/web succeeds');

    // Verify version is in sub-package, not root
    const webPkg = await readPkgJson(join(wsConsumerDir, 'apps/web'));
    const rootPkg = await readPkgJson(wsConsumerDir);
    assert(!!getDep(webPkg, '@test/pkg-a'), 'sub-package has @test/pkg-a');
    assert(!getDep(rootPkg, '@test/pkg-a'), 'root does NOT have @test/pkg-a');

    // Touch a file and republish to trigger consumer update
    await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// updated for test 17\n');
    const pubR = await pkglab(['pub', '@test/pkg-a'], { cwd: producerDir });
    assert(pubR.code === 0, 'pub succeeds');
    assert(pubR.stdout.includes('ws-consumer'), 'ws-consumer mentioned in update output');

    // Verify sub-package was updated (different version now)
    const webPkgAfter = await readPkgJson(join(wsConsumerDir, 'apps/web'));
    const verBefore = getDep(webPkg, '@test/pkg-a')!;
    const verAfter = getDep(webPkgAfter, '@test/pkg-a')!;
    assert(verAfter !== verBefore, 'sub-package version updated after pub');
    assert(verAfter.includes('0.0.0-pkglab.'), 'new version is pkglab format');

    // Restore and verify
    const restoreR = await pkglab(['restore', '--all'], { cwd: wsConsumerDir });
    assert(restoreR.code === 0, 'restore succeeds');

    // Clean up ws-consumer from repo state
    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('18. Bun catalog support');
  {
    // Create a bun workspace consumer with catalog
    const catConsumerDir = join(testDir, 'cat-consumer');
    await mkdir(join(catConsumerDir, 'apps/main'), { recursive: true });

    // Workspace root with catalog (use a real package for initial install)
    await writeJson(join(catConsumerDir, 'package.json'), {
      name: 'cat-consumer',
      private: true,
      workspaces: ['apps/*'],
      catalog: {
        '@test/pkg-a': '0.0.0',
      },
    });

    // Sub-package (no deps that would fail to resolve)
    await writeJson(join(catConsumerDir, 'apps/main/package.json'), {
      name: 'main-app',
      version: '1.0.0',
      dependencies: {},
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: catConsumerDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Add @test/pkg-a with --catalog flag
    const addR = await pkglab(['add', '@test/pkg-a', '--catalog'], { cwd: catConsumerDir });
    assert(addR.code === 0, 'pkglab add --catalog succeeds');

    // Verify catalog was updated in root package.json
    const rootPkg = await readPkgJson(catConsumerDir);
    assert(rootPkg.catalog['@test/pkg-a'].includes('0.0.0-pkglab.'), 'catalog entry updated to pkglab version');

    // Touch a file and republish to trigger consumer update
    await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// updated for test 18\n');
    const pubR = await pkglab(['pub', '@test/pkg-a'], { cwd: producerDir });
    assert(pubR.code === 0, 'pub succeeds');
    assert(pubR.stdout.includes('cat-consumer'), 'cat-consumer mentioned in update output');

    // Verify catalog version was updated again
    const rootPkgAfter = await readPkgJson(catConsumerDir);
    assert(rootPkgAfter.catalog['@test/pkg-a'] !== rootPkg.catalog['@test/pkg-a'], 'catalog version changed after pub');

    // Restore and verify catalog is back to original
    const restoreR = await pkglab(['restore', '--all'], { cwd: catConsumerDir });
    assert(restoreR.code === 0, 'restore succeeds');

    const rootPkgRestored = await readPkgJson(catConsumerDir);
    assert(rootPkgRestored.catalog['@test/pkg-a'] === '0.0.0', 'catalog restored to original version');

    // Clean up
    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('19. Catalog auto-detection (no --catalog flag)');
  {
    // Create a bun workspace consumer with catalog (same structure as test 18)
    const autoCatDir = join(testDir, 'autocat-consumer');
    await mkdir(join(autoCatDir, 'apps/main'), { recursive: true });

    // Workspace root with catalog containing @test/pkg-a
    await writeJson(join(autoCatDir, 'package.json'), {
      name: 'autocat-consumer',
      private: true,
      workspaces: ['apps/*'],
      catalog: {
        '@test/pkg-a': '0.0.0',
      },
    });

    // Sub-package
    await writeJson(join(autoCatDir, 'apps/main/package.json'), {
      name: 'autocat-app',
      version: '1.0.0',
      dependencies: {},
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: autoCatDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Add @test/pkg-a WITHOUT --catalog flag (should auto-detect)
    const addR = await pkglab(['add', '@test/pkg-a'], { cwd: autoCatDir });
    assert(addR.code === 0, 'pkglab add (auto-detect catalog) succeeds');
    assert(addR.stdout.includes('auto-detected catalog'), 'output mentions auto-detected catalog');
    assert(addR.stdout.includes('(catalog)'), 'output shows (catalog) in success message');

    // Verify catalog was updated in root package.json (not sub-package)
    const rootPkg = await readPkgJson(autoCatDir);
    assert(
      rootPkg.catalog['@test/pkg-a'].includes('0.0.0-pkglab.'),
      'catalog entry updated to pkglab version without --catalog flag',
    );

    // Verify sub-package was NOT modified
    const subPkg = await readPkgJson(join(autoCatDir, 'apps/main'));
    assert(!getDep(subPkg, '@test/pkg-a'), 'sub-package does NOT have @test/pkg-a (catalog handled it)');

    // Restore and verify catalog is back to original
    const restoreR = await pkglab(['restore', '--all'], { cwd: autoCatDir });
    assert(restoreR.code === 0, 'restore succeeds');

    const rootPkgRestored = await readPkgJson(autoCatDir);
    assert(rootPkgRestored.catalog['@test/pkg-a'] === '0.0.0', 'catalog restored to original version');

    // Clean up
    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('20. Multi-target auto-detection (no -p flag)');
  {
    // Create a bun workspace consumer with 2 sub-packages that both depend on @test/pkg-a
    const multiDir = join(testDir, 'multi-consumer');
    await mkdir(join(multiDir, 'apps/one'), { recursive: true });
    await mkdir(join(multiDir, 'apps/two'), { recursive: true });

    // Workspace root (no direct dep on @test/pkg-a)
    await writeJson(join(multiDir, 'package.json'), {
      name: 'multi-consumer',
      private: true,
      workspaces: ['apps/*'],
    });

    // Sub-package one
    await writeJson(join(multiDir, 'apps/one/package.json'), {
      name: 'app-one',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '0.0.0',
      },
    });

    // Sub-package two
    await writeJson(join(multiDir, 'apps/two/package.json'), {
      name: 'app-two',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '0.0.0',
      },
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: multiDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Add @test/pkg-a from workspace root WITHOUT -p (should auto-detect both sub-packages)
    const addR = await pkglab(['add', '@test/pkg-a'], { cwd: multiDir });
    assert(addR.code === 0, 'pkglab add (multi-target) succeeds');

    // Verify BOTH sub-packages were updated
    const onePkg = await readPkgJson(join(multiDir, 'apps/one'));
    const twoPkg = await readPkgJson(join(multiDir, 'apps/two'));
    const oneVer = getDep(onePkg, '@test/pkg-a');
    const twoVer = getDep(twoPkg, '@test/pkg-a');

    assert(!!oneVer, 'apps/one has @test/pkg-a');
    assert(oneVer!.includes('0.0.0-pkglab.'), 'apps/one has pkglab version');
    assert(!!twoVer, 'apps/two has @test/pkg-a');
    assert(twoVer!.includes('0.0.0-pkglab.'), 'apps/two has pkglab version');

    // Root should NOT have @test/pkg-a
    const rootPkg = await readPkgJson(multiDir);
    assert(!getDep(rootPkg, '@test/pkg-a'), 'root does NOT have @test/pkg-a');

    // Verify restore restores both sub-packages
    const restoreR = await pkglab(['restore', '--all'], { cwd: multiDir });
    assert(restoreR.code === 0, 'restore --all succeeds');

    const oneAfterRestore = await readPkgJson(join(multiDir, 'apps/one'));
    const twoAfterRestore = await readPkgJson(join(multiDir, 'apps/two'));
    assert(getDep(oneAfterRestore, '@test/pkg-a') === '0.0.0', 'apps/one restored to original version');
    assert(getDep(twoAfterRestore, '@test/pkg-a') === '0.0.0', 'apps/two restored to original version');

    // Clean up
    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('21. Opt-out with -p (single target)');
  {
    // Same workspace structure as test 20
    const optOutDir = join(testDir, 'optout-consumer');
    await mkdir(join(optOutDir, 'apps/one'), { recursive: true });
    await mkdir(join(optOutDir, 'apps/two'), { recursive: true });

    // Workspace root
    await writeJson(join(optOutDir, 'package.json'), {
      name: 'optout-consumer',
      private: true,
      workspaces: ['apps/*'],
    });

    // Sub-package one
    await writeJson(join(optOutDir, 'apps/one/package.json'), {
      name: 'optout-one',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '*',
      },
    });

    // Sub-package two (also depends on @test/pkg-a, should NOT be updated by -p)
    await writeJson(join(optOutDir, 'apps/two/package.json'), {
      name: 'optout-two',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '*',
      },
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: optOutDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Add @test/pkg-a with -p apps/one (should ONLY update apps/one)
    const addR = await pkglab(['add', '@test/pkg-a', '-p', 'apps/one'], { cwd: optOutDir });
    assert(addR.code === 0, 'pkglab add -p apps/one succeeds');

    // Verify apps/one was updated
    const onePkg = await readPkgJson(join(optOutDir, 'apps/one'));
    const oneVer = getDep(onePkg, '@test/pkg-a');
    assert(!!oneVer, 'apps/one has @test/pkg-a');
    assert(oneVer!.includes('0.0.0-pkglab.'), 'apps/one has pkglab version');

    // Verify apps/two was NOT updated
    const twoPkg = await readPkgJson(join(optOutDir, 'apps/two'));
    const twoVer = getDep(twoPkg, '@test/pkg-a');
    assert(twoVer === '*', 'apps/two still has original version (not updated)');

    // Restore and verify
    const restoreR = await pkglab(['restore', '--all'], { cwd: optOutDir });
    assert(restoreR.code === 0, 'restore succeeds');

    const oneAfterRestore = await readPkgJson(join(optOutDir, 'apps/one'));
    assert(getDep(oneAfterRestore, '@test/pkg-a') === '*', 'apps/one restored to original version');

    // Clean up
    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('22. Catalog + multi-target coexistence');
  {
    // Workspace where root has a catalog with @test/pkg-a,
    // and sub-packages reference it via "catalog:" protocol.
    const coexistDir = join(testDir, 'coexist-consumer');
    await mkdir(join(coexistDir, 'apps/one'), { recursive: true });
    await mkdir(join(coexistDir, 'apps/two'), { recursive: true });

    // First create workspace root WITHOUT catalog deps so bun install can create a lockfile.
    // The catalog references @test/pkg-a which only exists on the local registry,
    // and bun install can't resolve it without an .npmrc pointing there.
    await writeJson(join(coexistDir, 'package.json'), {
      name: 'coexist-consumer',
      private: true,
      workspaces: ['apps/*'],
    });

    // Sub-packages with no deps initially
    await writeJson(join(coexistDir, 'apps/one/package.json'), {
      name: 'coexist-one',
      version: '1.0.0',
      dependencies: {},
    });

    await writeJson(join(coexistDir, 'apps/two/package.json'), {
      name: 'coexist-two',
      version: '1.0.0',
      dependencies: {},
    });

    // bun install to create lockfile (for PM detection)
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: coexistDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Now write the real package.json files with catalog and catalog: protocol
    await writeJson(join(coexistDir, 'package.json'), {
      name: 'coexist-consumer',
      private: true,
      workspaces: ['apps/*'],
      catalog: {
        '@test/pkg-a': '0.0.0',
      },
    });

    await writeJson(join(coexistDir, 'apps/one/package.json'), {
      name: 'coexist-one',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': 'catalog:',
      },
    });

    await writeJson(join(coexistDir, 'apps/two/package.json'), {
      name: 'coexist-two',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': 'catalog:',
      },
    });

    // Add @test/pkg-a without flags (should auto-detect catalog)
    const addR = await pkglab(['add', '@test/pkg-a'], { cwd: coexistDir });
    assert(addR.code === 0, 'pkglab add (catalog coexist) succeeds');
    assert(addR.stdout.includes('auto-detected catalog'), 'output mentions auto-detected catalog');

    // Verify catalog entry was updated in root package.json
    const rootPkg = await readPkgJson(coexistDir);
    assert(rootPkg.catalog['@test/pkg-a'].includes('0.0.0-pkglab.'), 'catalog entry updated to pkglab version');

    // Verify sub-packages were NOT directly modified (still use "catalog:" protocol)
    const onePkg = await readPkgJson(join(coexistDir, 'apps/one'));
    const twoPkg = await readPkgJson(join(coexistDir, 'apps/two'));
    assert(getDep(onePkg, '@test/pkg-a') === 'catalog:', 'apps/one still uses catalog: protocol (not modified)');
    assert(getDep(twoPkg, '@test/pkg-a') === 'catalog:', 'apps/two still uses catalog: protocol (not modified)');

    // Restore and verify catalog is back to original
    const restoreR = await pkglab(['restore', '--all'], { cwd: coexistDir });
    assert(restoreR.code === 0, 'restore succeeds');

    const rootPkgRestored = await readPkgJson(coexistDir);
    assert(rootPkgRestored.catalog['@test/pkg-a'] === '0.0.0', 'catalog restored to original version');

    // Clean up
    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('23. --tag flag (basic)');
  {
    const tagConsumerDir = join(testDir, 'tag-consumer');
    await mkdir(tagConsumerDir, { recursive: true });

    await writeJson(join(tagConsumerDir, 'package.json'), {
      name: 'tag-consumer',
      version: '1.0.0',
      dependencies: {},
    });

    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: tagConsumerDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Add @test/pkg-a with --tag feat1 (no inline @ syntax)
    const addR = await pkglab(['add', '@test/pkg-a', '--tag', 'feat1'], { cwd: tagConsumerDir });
    assert(addR.code === 0, 'pkglab add --tag feat1 succeeds');

    const pkg = await readPkgJson(tagConsumerDir);
    const ver = getDep(pkg, '@test/pkg-a');
    assert(!!ver, 'consumer has @test/pkg-a in deps');
    assert(ver!.includes('0.0.0-pkglab-feat1.'), 'version is tagged pkglab-feat1 format');

    // Restore and clean up
    const restoreR = await pkglab(['restore', '--all'], { cwd: tagConsumerDir });
    assert(restoreR.code === 0, 'restore succeeds');

    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('24. --tag conflict with inline @tag');
  {
    const conflictDir = join(testDir, 'tag-conflict-consumer');
    await mkdir(conflictDir, { recursive: true });

    await writeJson(join(conflictDir, 'package.json'), {
      name: 'tag-conflict-consumer',
      version: '1.0.0',
      dependencies: {},
    });

    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: conflictDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    const r = await pkglab(['add', '@test/pkg-a@feat1', '--tag', 'feat1'], { cwd: conflictDir });
    assert(r.code !== 0, 'pkglab add with --tag and inline @tag fails');

    const combined = r.stdout + r.stderr;
    assert(
      combined.includes('Cannot combine --tag with inline @tag'),
      'error mentions Cannot combine --tag with inline @tag',
    );

    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('25. --scope basic');
  {
    // Workspace consumer with two sub-packages, both using @test/pkg-a and @test/pkg-b
    const scopeDir = join(testDir, 'scope-consumer');
    await mkdir(join(scopeDir, 'apps/one'), { recursive: true });
    await mkdir(join(scopeDir, 'apps/two'), { recursive: true });

    // Workspace root (no direct deps)
    await writeJson(join(scopeDir, 'package.json'), {
      name: 'scope-consumer',
      private: true,
      workspaces: ['apps/*'],
    });

    // Sub-package one
    await writeJson(join(scopeDir, 'apps/one/package.json'), {
      name: 'scope-one',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '*',
        '@test/pkg-b': '*',
      },
    });

    // Sub-package two
    await writeJson(join(scopeDir, 'apps/two/package.json'), {
      name: 'scope-two',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '*',
        '@test/pkg-b': '*',
      },
    });

    // bun install BEFORE adding the real deps (same pattern as test 22)
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: scopeDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Run pkglab add --scope test (without @, to test normalization)
    const addR = await pkglab(['add', '--scope', 'test'], { cwd: scopeDir });
    assert(addR.code === 0, 'pkglab add --scope test succeeds');

    const combined = addR.stdout + addR.stderr;
    assert(combined.includes('Found 2 packages matching @test/*'), 'output mentions Found 2 packages matching @test/*');

    // Verify both packages updated in both sub-packages
    const onePkg = await readPkgJson(join(scopeDir, 'apps/one'));
    const twoPkg = await readPkgJson(join(scopeDir, 'apps/two'));

    const oneA = getDep(onePkg, '@test/pkg-a');
    const oneB = getDep(onePkg, '@test/pkg-b');
    const twoA = getDep(twoPkg, '@test/pkg-a');
    const twoB = getDep(twoPkg, '@test/pkg-b');

    assert(!!oneA && oneA.includes('0.0.0-pkglab.'), 'apps/one @test/pkg-a has pkglab version');
    assert(!!oneB && oneB.includes('0.0.0-pkglab.'), 'apps/one @test/pkg-b has pkglab version');
    assert(!!twoA && twoA.includes('0.0.0-pkglab.'), 'apps/two @test/pkg-a has pkglab version');
    assert(!!twoB && twoB.includes('0.0.0-pkglab.'), 'apps/two @test/pkg-b has pkglab version');

    // Restore and verify both packages in both sub-packages are restored
    const restoreR = await pkglab(['restore', '--all'], { cwd: scopeDir });
    assert(restoreR.code === 0, 'restore --all succeeds');

    const oneAfter = await readPkgJson(join(scopeDir, 'apps/one'));
    const twoAfter = await readPkgJson(join(scopeDir, 'apps/two'));

    assert(getDep(oneAfter, '@test/pkg-a') === '*', 'apps/one @test/pkg-a restored');
    assert(getDep(oneAfter, '@test/pkg-b') === '*', 'apps/one @test/pkg-b restored');
    assert(getDep(twoAfter, '@test/pkg-a') === '*', 'apps/two @test/pkg-a restored');
    assert(getDep(twoAfter, '@test/pkg-b') === '*', 'apps/two @test/pkg-b restored');

    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('26. --scope with unpublished package');
  {
    const scopeUnpubDir = join(testDir, 'scope-unpub-consumer');
    await mkdir(join(scopeUnpubDir, 'apps/main'), { recursive: true });

    await writeJson(join(scopeUnpubDir, 'package.json'), {
      name: 'scope-unpub-consumer',
      private: true,
      workspaces: ['apps/*'],
    });

    await writeJson(join(scopeUnpubDir, 'apps/main/package.json'), {
      name: 'scope-unpub-app',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '*',
        '@test/nonexistent': '*',
      },
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: scopeUnpubDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Record @test/pkg-a version before the command
    const pkgBefore = await readPkgJson(join(scopeUnpubDir, 'apps/main'));
    const verBefore = getDep(pkgBefore, '@test/pkg-a');

    const r = await pkglab(['add', '--scope', 'test'], { cwd: scopeUnpubDir });
    assert(r.code !== 0, 'pkglab add --scope with unpublished package fails');

    const combined = r.stdout + r.stderr;
    assert(combined.includes('not published'), 'error mentions not published');

    // Verify @test/pkg-a was NOT modified (atomic: nothing touched on failure)
    const pkgAfter = await readPkgJson(join(scopeUnpubDir, 'apps/main'));
    const verAfter = getDep(pkgAfter, '@test/pkg-a');
    assert(verAfter === verBefore, '@test/pkg-a was not modified on failure');

    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('27. --scope + --tag');
  {
    const scopeTagDir = join(testDir, 'scope-tag-consumer');
    await mkdir(join(scopeTagDir, 'apps/main'), { recursive: true });

    await writeJson(join(scopeTagDir, 'package.json'), {
      name: 'scope-tag-consumer',
      private: true,
      workspaces: ['apps/*'],
    });

    await writeJson(join(scopeTagDir, 'apps/main/package.json'), {
      name: 'scope-tag-app',
      version: '1.0.0',
      dependencies: {
        '@test/pkg-a': '*',
      },
    });

    // bun install to create lockfile
    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: scopeTagDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    // Run pkglab add --scope test --tag feat1
    const addR = await pkglab(['add', '--scope', 'test', '--tag', 'feat1'], { cwd: scopeTagDir });
    assert(addR.code === 0, 'pkglab add --scope test --tag feat1 succeeds');

    // Verify version is tagged pkglab-feat1 format
    const mainPkg = await readPkgJson(join(scopeTagDir, 'apps/main'));
    const ver = getDep(mainPkg, '@test/pkg-a');
    assert(!!ver, 'apps/main has @test/pkg-a in deps');
    assert(ver!.includes('0.0.0-pkglab-feat1.'), 'version is tagged pkglab-feat1 format');

    // Restore and clean up
    const restoreR = await pkglab(['restore', '--all'], { cwd: scopeTagDir });
    assert(restoreR.code === 0, 'restore succeeds');

    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  heading('28. --scope + positional args conflict');
  {
    const scopeArgsDir = join(testDir, 'scope-args-consumer');
    await mkdir(scopeArgsDir, { recursive: true });

    await writeJson(join(scopeArgsDir, 'package.json'), {
      name: 'scope-args-consumer',
      version: '1.0.0',
      dependencies: {},
    });

    const bunInit = Bun.spawn(['bun', 'install'], {
      cwd: scopeArgsDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunInit.exited;

    const r = await pkglab(['add', '@test/pkg-a', '--scope', 'test'], { cwd: scopeArgsDir });
    assert(r.code !== 0, 'pkglab add with --scope and positional args fails');

    const combined = r.stdout + r.stderr;
    assert(
      combined.includes('Cannot combine --scope with package names'),
      'error mentions Cannot combine --scope with package names',
    );

    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  // === Audit fix verification tests ===

  // A1. Fingerprint negation patterns: files matching !pattern are excluded
  heading('A1. Fingerprint negation patterns');
  {
    const negDir = join(testDir, 'negation-test');
    await mkdir(join(negDir, 'packages/neg-pkg/dist/internal'), { recursive: true });

    await writeJson(join(negDir, 'package.json'), {
      name: 'negation-workspace',
      private: true,
      workspaces: ['packages/*'],
    });

    await writeJson(join(negDir, 'packages/neg-pkg/package.json'), {
      name: '@test/neg-pkg',
      version: '1.0.0',
      files: ['dist', '!dist/internal'],
    });

    // Create files: dist/index.js (included) and dist/internal/secret.js (excluded)
    await Bun.write(join(negDir, 'packages/neg-pkg/dist/index.js'), 'export const x = 1;\n');
    await Bun.write(join(negDir, 'packages/neg-pkg/dist/internal/secret.js'), 'secret\n');

    // First publish using cascade path to establish fingerprint state
    const r1 = await pkglab(['pub', '@test/neg-pkg'], { cwd: negDir });
    assert(r1.code === 0, 'pub with negation files succeeds');

    // Change the excluded file only
    await Bun.write(join(negDir, 'packages/neg-pkg/dist/internal/secret.js'), 'modified secret\n');

    // Second publish should detect no changes (excluded file changed)
    const r2 = await pkglab(['pub', '@test/neg-pkg'], { cwd: negDir });
    assert(r2.code === 0, 'pub after excluded file change succeeds');
    assert(
      r2.stdout.includes('unchanged') || r2.stdout.includes('Nothing to publish'),
      'excluded file change does not trigger republish',
      r2,
    );

    // Change the included file
    await Bun.write(join(negDir, 'packages/neg-pkg/dist/index.js'), 'export const x = 2;\n');

    // Third publish should detect changes
    const r3 = await pkglab(['pub', '@test/neg-pkg'], { cwd: negDir });
    assert(r3.code === 0, 'pub after included file change succeeds');

    // Clean up
    await pkglab(['pkg', 'rm', '@test/neg-pkg']).catch(() => {});
  }

  // A2. .gitignore applied when no files field
  heading('A2. gitignore applied when no files field');
  {
    const ignoreDir = join(testDir, 'ignore-test');
    await mkdir(join(ignoreDir, 'packages/ign-pkg/dist'), { recursive: true });
    await mkdir(join(ignoreDir, 'packages/ign-pkg/coverage'), { recursive: true });

    await writeJson(join(ignoreDir, 'package.json'), {
      name: 'ignore-workspace',
      private: true,
      workspaces: ['packages/*'],
    });

    // Package without files field but with .gitignore
    await writeJson(join(ignoreDir, 'packages/ign-pkg/package.json'), {
      name: '@test/ign-pkg',
      version: '1.0.0',
    });
    await Bun.write(join(ignoreDir, 'packages/ign-pkg/.gitignore'), 'coverage\n');
    await Bun.write(join(ignoreDir, 'packages/ign-pkg/dist/index.js'), 'export const x = 1;\n');
    await Bun.write(join(ignoreDir, 'packages/ign-pkg/coverage/report.html'), '<html>coverage</html>\n');

    // First publish using cascade path to establish fingerprint state
    const r1 = await pkglab(['pub', '@test/ign-pkg'], { cwd: ignoreDir });
    assert(r1.code === 0, 'pub with gitignore succeeds');

    // Change only the ignored file
    await Bun.write(join(ignoreDir, 'packages/ign-pkg/coverage/report.html'), '<html>updated</html>\n');

    // Should not trigger republish
    const r2 = await pkglab(['pub', '@test/ign-pkg'], { cwd: ignoreDir });
    assert(r2.code === 0, 'pub after ignored file change succeeds');
    assert(
      r2.stdout.includes('unchanged') || r2.stdout.includes('Nothing to publish'),
      'gitignored file change does not trigger republish',
      r2,
    );

    await pkglab(['pkg', 'rm', '@test/ign-pkg']).catch(() => {});
  }

  // A3. Catalog resolution failure throws instead of degrading to *
  heading('A3. Catalog resolution throws on missing entry');
  {
    const catDir = join(testDir, 'catalog-err-test');
    await mkdir(join(catDir, 'packages/cat-pkg'), { recursive: true });

    await writeJson(join(catDir, 'package.json'), {
      name: 'catalog-err-workspace',
      private: true,
      workspaces: ['packages/*'],
      catalog: {
        '@test/known-dep': '^1.0.0',
      },
    });

    // Package with a catalog: reference to a dep that's NOT in the catalog
    await writeJson(join(catDir, 'packages/cat-pkg/package.json'), {
      name: '@test/cat-pkg',
      version: '1.0.0',
      dependencies: {
        '@test/unknown-catalog-dep': 'catalog:nonexistent',
      },
    });

    await Bun.write(join(catDir, 'packages/cat-pkg/index.js'), 'export default 1;\n');

    const r = await pkglab(['pub', '--single', '@test/cat-pkg'], { cwd: catDir });
    assert(r.code !== 0, 'pub fails when catalog entry cannot be resolved');
    const output = r.stdout + r.stderr;
    assert(
      output.includes('Could not resolve catalog:nonexistent'),
      'error message mentions unresolvable catalog',
      r,
    );

    await pkglab(['pkg', 'rm', '@test/cat-pkg']).catch(() => {});
  }

  // A4. Publisher backup restore logs on failure (verified by checking the backup code path works)
  heading('A4. Publisher backup recovery on next publish');
  {
    // Create a leftover .pkglab backup to simulate a crashed publish
    const backupDir = join(testDir, 'backup-test');
    await mkdir(join(backupDir, 'packages/bak-pkg'), { recursive: true });

    await writeJson(join(backupDir, 'package.json'), {
      name: 'backup-workspace',
      private: true,
      workspaces: ['packages/*'],
    });

    const originalPkgJson = {
      name: '@test/bak-pkg',
      version: '1.0.0',
    };
    await writeJson(join(backupDir, 'packages/bak-pkg/package.json'), originalPkgJson);

    // Simulate a crashed publish by leaving a .pkglab backup
    await writeJson(join(backupDir, 'packages/bak-pkg/package.json.pkglab'), originalPkgJson);
    // Write a modified package.json (as if mid-publish)
    await writeJson(join(backupDir, 'packages/bak-pkg/package.json'), {
      ...originalPkgJson,
      version: '0.0.0-pkglab.999999',
    });

    await Bun.write(join(backupDir, 'packages/bak-pkg/index.js'), 'export default 1;\n');

    // Publishing should recover the backup first, then publish normally
    const r = await pkglab(['pub', '--single', '@test/bak-pkg'], { cwd: backupDir });
    assert(r.code === 0, 'pub recovers from leftover backup and succeeds');

    // After publish, original package.json should be restored (not the mid-publish version)
    const pkg = await readPkgJson(join(backupDir, 'packages/bak-pkg'));
    assert(pkg.version === '1.0.0', 'original package.json version restored after publish');

    // No leftover backup
    const backupExists = await Bun.file(join(backupDir, 'packages/bak-pkg/package.json.pkglab')).exists();
    assert(!backupExists, 'no leftover .pkglab backup after publish');

    await pkglab(['pkg', 'rm', '@test/bak-pkg']).catch(() => {});
  }

  // A5. skip-worktree notice mentions pre-commit hook, not skip-worktree
  heading('A5. NPMRC notice mentions pre-commit hook');
  {
    const noticeDir = join(testDir, 'notice-test');
    await mkdir(noticeDir, { recursive: true });

    await writeJson(join(noticeDir, 'package.json'), {
      name: 'notice-test-consumer',
      version: '1.0.0',
      dependencies: {},
    });

    const bunProc = Bun.spawn(['bun', 'install'], {
      cwd: noticeDir,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await bunProc.exited;

    const r = await pkglab(['add', '@test/pkg-a'], { cwd: noticeDir });
    assert(r.code === 0, 'pkglab add succeeds for notice test');

    const output = r.stdout + r.stderr;
    assert(!output.includes('skip-worktree'), 'notice does NOT mention skip-worktree');
    assert(output.includes('pre-commit hook'), 'notice mentions pre-commit hook');

    // Cleanup
    await pkglab(['restore', '--all'], { cwd: noticeDir }).catch(() => {});
    await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  }

  // A6. README says "retry" not "rollback"
  heading('A6. README uses "retry" not "rollback"');
  {
    const { readFileSync } = await import('node:fs');
    const readmePath = resolve(import.meta.dir, '..', 'README.md');
    const readmeContent = readFileSync(readmePath, 'utf-8');
    assert(
      readmeContent.includes('parallel publishes with retry'),
      'README says "parallel publishes with retry"',
    );
    assert(
      !readmeContent.includes('parallel publishes with rollback'),
      'README does NOT say "parallel publishes with rollback"',
    );
    console.log('  pass: README rollback claim fixed');
    passed++;
  }

  // A7. Pending update state saved before consumer install
  heading('A7. Pending update state and crash recovery');
  {
    // We can't easily simulate a crash mid-install, but we can verify:
    // 1. After a successful pub with consumer updates, pendingUpdate is cleared
    // 2. The repo state module correctly handles the pendingUpdate field

    // Ensure consumer-2 is still active with @test/pkg-a
    const c2State = await Bun.file(join(testDir, 'consumer-2/package.json')).json();
    const c2HasPkg = !!getDep(c2State, '@test/pkg-a');

    if (c2HasPkg) {
      // Touch a file to force republish
      await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// pending test\n');
      const r = await pkglab(['pub'], { cwd: producerDir });
      assert(r.code === 0, 'pub succeeds for pending state test');

      // Load repo state and verify pendingUpdate is cleared
      const { loadRepoByPath } = await import('../src/lib/repo-state');
      const consumer2Path = resolve(consumer2Dir);
      const state = await loadRepoByPath(consumer2Path);
      assert(state !== null, 'consumer-2 repo state exists');
      assert(!state!.pendingUpdate, 'pendingUpdate is cleared after successful install');
    } else {
      // Re-add and test
      const addR = await pkglab(['add', '@test/pkg-a@feat1'], { cwd: consumer2Dir });
      assert(addR.code === 0, 're-add pkg-a to consumer-2 for pending test');

      await Bun.write(join(producerDir, 'packages/pkg-a/index.js'), '// pending test 2\n');
      const r = await pkglab(['pub', '-t', 'feat1'], { cwd: producerDir });
      assert(r.code === 0, 'pub succeeds for pending state test');

      const { loadRepoByPath } = await import('../src/lib/repo-state');
      const consumer2Path = resolve(consumer2Dir);
      const state = await loadRepoByPath(consumer2Path);
      assert(state !== null, 'consumer-2 repo state exists');
      assert(!state!.pendingUpdate, 'pendingUpdate is cleared after successful install');
    }
  }

  heading('Results');
  console.log(`  ${passed} passed, ${failed} failed`);
} finally {
  // Cleanup
  heading('Cleanup');
  await pkglab(['repo', 'reset', '--all']).catch(() => {});
  await pkglab(['pkg', 'rm', '@test/pkg-a', '@test/pkg-b', '@test/pkg-c']).catch(() => {});
  await pkglab(['down']).catch(() => {});
  await rm(testDir, { recursive: true, force: true });
  await pkglab(['repo', 'reset', '--stale']).catch(() => {});
  console.log(`  Removed ${testDir}`);
}

process.exit(failed > 0 ? 1 : 0);
