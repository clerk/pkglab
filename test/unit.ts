export {}; // module marker for top-level await

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.log(`  FAIL: ${msg}`);
    failed++;
    throw new Error(msg);
  }
  console.log(`  pass: ${msg}`);
  passed++;
}

function heading(msg: string) {
  console.log(`\n── ${msg} ──`);
}

heading('run() timeout');
{
  const { run } = await import('../src/lib/proc');
  const start = Date.now();
  try {
    await run(['sleep', '10'], { timeout: 500 });
    assert(false, 'should have thrown');
  } catch (e: any) {
    const elapsed = Date.now() - start;
    assert(elapsed < 3000, `timed out promptly (${elapsed}ms)`);
    assert(e.message.includes('timed out'), `error message mentions timeout: ${e.message}`);
  }
}

heading('run() without timeout works normally');
{
  const { run } = await import('../src/lib/proc');
  const result = await run(['echo', 'hello'], {});
  assert(result.exitCode === 0, 'echo succeeds');
  assert(result.stdout.trim() === 'hello', 'echo output correct');
}

heading('acquirePublishLock basics');
{
  const { acquirePublishLock } = await import('../src/lib/lock');
  // Acquire lock
  const release = await acquirePublishLock();
  assert(typeof release === 'function', 'returns release function');
  // Release lock
  await release();
}

heading('atomicWrite');
{
  const { atomicWrite } = await import('../src/lib/fs');
  const { join } = await import('node:path');
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const tmpDir = await mkdtemp('/tmp/pkglab-test-atomic-');
  const testPath = join(tmpDir, 'test.json');

  await atomicWrite(testPath, '{"hello":"world"}\n');
  const content = await readFile(testPath, 'utf8');
  assert(content === '{"hello":"world"}\n', 'atomicWrite writes correct content');

  // Verify no .tmp file left behind
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(tmpDir);
  assert(files.length === 1, `no temp files left behind (found ${files.join(', ')})`);

  await rm(tmpDir, { recursive: true });
}

heading('fingerprintPath determinism');
{
  const { fingerprintPath } = await import('../src/lib/fingerprint-state');
  const p1 = fingerprintPath('/some/workspace');
  const p2 = fingerprintPath('/some/workspace');
  const p3 = fingerprintPath('/other/workspace');
  assert(p1 === p2, 'same workspace produces same path');
  assert(p1 !== p3, 'different workspaces produce different paths');
  assert(p1.endsWith('.json'), 'path ends with .json');
}

heading('fingerprint state round-trip');
{
  const { loadFingerprintState, saveFingerprintState, clearFingerprintState } = await import(
    '../src/lib/fingerprint-state'
  );
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');

  // Override fingerprintsDir to use a temp dir
  const { paths } = await import('../src/lib/paths');
  const origDir = paths.fingerprintsDir;
  const tmpDir = await mkdtemp('/tmp/pkglab-test-fp-');
  // @ts-expect-error - overriding readonly for test
  paths.fingerprintsDir = join(tmpDir, 'fingerprints');

  try {
    const workspace = '/test/workspace';

    // Initially empty
    const empty = await loadFingerprintState(workspace, null);
    assert(Object.keys(empty).length === 0, 'empty state on fresh load');

    // Save some entries
    await saveFingerprintState(workspace, null, [
      { name: '@scope/pkg-a', hash: 'abc123', version: '0.0.0-pkglab.1' },
      { name: '@scope/pkg-b', hash: 'def456', version: '0.0.0-pkglab.2' },
    ]);

    // Load back
    const loaded = await loadFingerprintState(workspace, null);
    assert(loaded['@scope/pkg-a']?.hash === 'abc123', 'pkg-a hash matches');
    assert(loaded['@scope/pkg-b']?.version === '0.0.0-pkglab.2', 'pkg-b version matches');

    // Tagged entries are isolated
    await saveFingerprintState(workspace, 'feat1', [
      { name: '@scope/pkg-a', hash: 'tagged-hash', version: '0.0.0-pkglab-feat1.3' },
    ]);
    const untagged = await loadFingerprintState(workspace, null);
    assert(untagged['@scope/pkg-a']?.hash === 'abc123', 'untagged state unchanged after tagged save');
    const tagged = await loadFingerprintState(workspace, 'feat1');
    assert(tagged['@scope/pkg-a']?.hash === 'tagged-hash', 'tagged state loads correctly');

    // Different workspace is isolated
    const other = await loadFingerprintState('/other/workspace', null);
    assert(Object.keys(other).length === 0, 'different workspace is empty');

    // Clear removes everything
    await clearFingerprintState();
    const afterClear = await loadFingerprintState(workspace, null);
    assert(Object.keys(afterClear).length === 0, 'state empty after clear');
  } finally {
    // Restore original path
    // @ts-expect-error - overriding readonly for test
    paths.fingerprintsDir = origDir;
    await rm(tmpDir, { recursive: true });
  }
}

heading('regex /g lastIndex bug');
{
  // Simulate the bug: a module-level /g regex retains lastIndex across calls
  const re = /"http:\/\/(?:127\.0\.0\.1|localhost):[^"]*"/g;
  const content = '"http://127.0.0.1:4873/pkg/-/pkg-1.0.0.tgz"';

  // First call advances lastIndex
  const first = re.test(content);
  assert(first === true, 'first .test() finds the match');
  assert(re.lastIndex > 0, 'lastIndex advanced after first .test()');

  // Without reset, second call on the same content can return false
  const secondWithoutReset = re.test(content);
  assert(secondWithoutReset === false, 'second .test() without reset misses the match (the bug)');

  // With reset, it works correctly
  re.lastIndex = 0;
  const secondWithReset = re.test(content);
  assert(secondWithReset === true, 'second .test() after lastIndex reset finds the match (the fix)');
}

heading('removepkglabBlock multiple markers');
{
  const { removepkglabBlock } = await import('../src/lib/consumer');
  const input = 'before\n# pkglab-start\nfoo\n# pkglab-end\nmiddle\n# pkglab-start\nbar\n# pkglab-end\nafter\n';
  const result = removepkglabBlock(input);
  assert(!result.includes('# pkglab-start'), 'no start markers remain');
  assert(!result.includes('# pkglab-end'), 'no end markers remain');
  assert(result.includes('before'), 'content before preserved');
  assert(result.includes('after'), 'content after preserved');
}

heading('deterministicToposort cycle detection');
{
  const { deterministicToposort } = await import('../src/lib/graph');
  const { DepGraph } = await import('dependency-graph');
  const graph = new DepGraph();
  graph.addNode('a', {});
  graph.addNode('b', {});
  graph.addNode('c', {});
  graph.addDependency('a', 'b');
  graph.addDependency('b', 'c');
  graph.addDependency('c', 'a');

  const result = deterministicToposort(graph as any, new Set(['a', 'b', 'c']));
  assert(result.length === 3, `toposort returns all nodes despite cycle (got ${result.length})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
