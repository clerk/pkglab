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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
