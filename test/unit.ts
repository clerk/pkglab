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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
