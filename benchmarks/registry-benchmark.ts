/**
 * Registry benchmark for the pkglab registry server.
 *
 * Creates a realistic multi-package workspace (15 packages with interdependencies)
 * and measures the full `pkglab pub` cycle, which includes cascade computation,
 * fingerprinting, and parallel publish via Promise.allSettled.
 *
 * Usage:
 *   bun run benchmarks/registry-benchmark.ts
 */

import { mkdir, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = 16180;
const REGISTRY_URL = `http://127.0.0.1:${PORT}`;
const PKGLAB_HOME = join(homedir(), '.pkglab');
const PID_PATH = join(PKGLAB_HOME, 'pid');
const FINGERPRINTS_PATH = join(PKGLAB_HOME, 'fingerprints.json');
const PKGLAB_BIN = ['bun', join(import.meta.dir, '..', 'src', 'index.ts')];

const COLD_START_RUNS = 5;
const PUBLISH_RUNS = 5;
const PUBLISH_WARMUP = 1;
const PACKUMENT_RUNS = 30;

// Number of fixture packages to create. Simulates a real monorepo like Clerk (~15 packages).
const FIXTURE_PACKAGE_COUNT = 15;

type Backend = 'verbunccio';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { backends: Backend[] } {
  return { backends: ['verbunccio'] };
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

interface Stats {
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
  samples: number;
}

function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    return { p50: 0, p95: 0, min: 0, max: 0, mean: 0, samples: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { p50, p95, min, max, mean, samples: sorted.length };
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 1) return sorted[0];
  const rank = (pct / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms).toLocaleString()}ms`;
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtMb(kb: number): string {
  return `${(kb / 1024).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function runCmd(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<RunResult> {
  const mergedEnv = { ...process.env, ...opts.env } as Record<string, string>;
  // Remove keys explicitly set to undefined
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete mergedEnv[k];
    }
  }

  const t0 = performance.now();
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: mergedEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, opts.timeoutMs)
      : undefined;

  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);
  const durationMs = performance.now() - t0;

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (timedOut) {
    return { exitCode: -1, stdout, stderr: stderr + '\n[timed out]', durationMs };
  }
  return { exitCode, stdout, stderr, durationMs };
}

// ---------------------------------------------------------------------------
// Fixture setup: realistic multi-package workspace
// ---------------------------------------------------------------------------

const BENCH_DIR = `/tmp/pkglab-bench-${Date.now()}`;

// Fixture packages that mimic a real monorepo (like Clerk).
// Includes a dependency tree: types is a leaf, shared depends on types,
// and most packages depend on shared/types.
interface FixturePackage {
  name: string;
  deps: string[];
}

function buildFixtureManifest(): FixturePackage[] {
  const pkgs: FixturePackage[] = [
    { name: '@bench/types', deps: [] },
    { name: '@bench/shared', deps: ['@bench/types'] },
    { name: '@bench/core', deps: ['@bench/shared', '@bench/types'] },
    { name: '@bench/react', deps: ['@bench/core', '@bench/shared', '@bench/types'] },
    { name: '@bench/nextjs', deps: ['@bench/react', '@bench/core', '@bench/shared'] },
    { name: '@bench/express', deps: ['@bench/core', '@bench/shared'] },
    { name: '@bench/fastify', deps: ['@bench/core', '@bench/shared'] },
    { name: '@bench/backend', deps: ['@bench/core', '@bench/shared', '@bench/types'] },
    { name: '@bench/sdk-node', deps: ['@bench/backend', '@bench/shared'] },
    { name: '@bench/testing', deps: ['@bench/core', '@bench/types'] },
    { name: '@bench/themes', deps: ['@bench/types'] },
    { name: '@bench/localizations', deps: ['@bench/types'] },
    { name: '@bench/elements', deps: ['@bench/react', '@bench/shared', '@bench/types'] },
    { name: '@bench/upgrade', deps: ['@bench/core', '@bench/shared'] },
    { name: '@bench/tanstack-start', deps: ['@bench/react', '@bench/core', '@bench/shared'] },
  ];

  return pkgs.slice(0, FIXTURE_PACKAGE_COUNT);
}

async function createFixtures(): Promise<{ wsRoot: string; packages: FixturePackage[] }> {
  const wsRoot = join(BENCH_DIR, 'workspace');
  const manifest = buildFixtureManifest();

  // Workspace root package.json
  await mkdir(join(wsRoot, 'packages'), { recursive: true });
  await Bun.write(
    join(wsRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'bench-workspace',
        private: true,
        workspaces: ['packages/*'],
      },
      null,
      2,
    ),
  );

  // Create each fixture package
  for (const pkg of manifest) {
    // Package directory name: strip scope, e.g. "@bench/shared" -> "shared"
    const shortName = pkg.name.split('/')[1];
    const pkgDir = join(wsRoot, 'packages', shortName);
    const distDir = join(pkgDir, 'dist');
    await mkdir(distDir, { recursive: true });

    // Build dependencies as workspace: protocol refs
    const dependencies: Record<string, string> = {};
    for (const dep of pkg.deps) {
      dependencies[dep] = 'workspace:^';
    }

    await Bun.write(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: pkg.name,
          version: '1.0.0',
          files: ['dist'],
          main: 'dist/index.js',
          types: 'dist/index.d.ts',
          ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
        },
        null,
        2,
      ),
    );

    // Generate ~30-60KB of code per package (varied size for realism)
    const fnCount = 200 + Math.floor(Math.random() * 400);
    let code = `// Generated benchmark fixture: ${pkg.name}\n`;
    for (const dep of pkg.deps) {
      code += `// depends on: ${dep}\n`;
    }
    for (let i = 0; i < fnCount; i++) {
      code += `export function fn${i}(a: number, b: number): number { return a + b + ${i}; }\n`;
    }
    await Bun.write(join(distDir, 'index.js'), code);
    await Bun.write(
      join(distDir, 'index.d.ts'),
      Array.from({ length: fnCount }, (_, i) => `export declare function fn${i}(a: number, b: number): number;\n`).join(
        '',
      ),
    );
  }

  console.log(`  created ${manifest.length} packages with interdependencies`);

  return { wsRoot, packages: manifest };
}

async function cleanFixtures(): Promise<void> {
  await rm(BENCH_DIR, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Registry lifecycle helpers
// ---------------------------------------------------------------------------

function backendEnv(_backend: Backend): Record<string, string | undefined> {
  return {};
}

async function pkglabDown(backend: Backend): Promise<void> {
  await runCmd([...PKGLAB_BIN, 'down'], { env: backendEnv(backend), timeoutMs: 15_000 });
}

async function pkglabUp(backend: Backend): Promise<RunResult> {
  return runCmd([...PKGLAB_BIN, 'up'], { env: backendEnv(backend), timeoutMs: 30_000 });
}

async function clearFingerprints(): Promise<void> {
  await unlink(FINGERPRINTS_PATH).catch(() => {});
}

async function waitForRegistry(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${REGISTRY_URL}/-/ping`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return true;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
  return false;
}

async function readPid(): Promise<number | null> {
  try {
    const data = await Bun.file(PID_PATH).json();
    return data.pid ?? null;
  } catch {
    return null;
  }
}

async function readRssKb(pid: number): Promise<number> {
  const result = await runCmd(['ps', '-o', 'rss=', '-p', String(pid)]);
  if (result.exitCode !== 0) return 0;
  return parseInt(result.stdout.trim(), 10) || 0;
}

// ---------------------------------------------------------------------------
// Benchmark runners
// ---------------------------------------------------------------------------

async function benchColdStart(backend: Backend): Promise<number[]> {
  const times: number[] = [];

  for (let i = 0; i < COLD_START_RUNS; i++) {
    await pkglabDown(backend);
    await Bun.sleep(300); // small settle time

    const t0 = performance.now();
    const result = await pkglabUp(backend);
    const elapsed = performance.now() - t0;

    if (result.exitCode !== 0) {
      // Might be "already running" if previous down didn't fully stop
      const ready = await waitForRegistry(5000);
      if (!ready) {
        console.error(`  [${backend}] cold start attempt ${i + 1} failed: ${result.stderr.slice(0, 200)}`);
        continue;
      }
    }

    times.push(elapsed);
    process.stdout.write(`  cold start #${i + 1}: ${fmtMs(elapsed)}\n`);
  }

  return times;
}

/**
 * Multi-package publish benchmark.
 *
 * Runs `pkglab pub --force` from the workspace root, which exercises the full
 * publish path: cascade computation, fingerprinting, parallel publish of all
 * packages via Promise.allSettled, and dist-tag updates.
 *
 * This is what matters in practice. A single `bun publish` takes ~65ms regardless
 * of backend (dominated by process startup). The real difference shows up when
 * 15 packages publish in parallel and the registry handles concurrent writes.
 */
async function benchPublish(backend: Backend, wsRoot: string): Promise<number[]> {
  const times: number[] = [];

  // Make sure registry is up
  const upResult = await pkglabUp(backend);
  if (upResult.exitCode !== 0) {
    const ready = await waitForRegistry(5000);
    if (!ready) {
      console.error(`  [${backend}] registry not available for publish bench`);
      return times;
    }
  }

  for (let i = 0; i < PUBLISH_RUNS + PUBLISH_WARMUP; i++) {
    // Clear fingerprints so each publish actually goes through
    await clearFingerprints();

    // Use --force to bypass fingerprint cache (republish everything).
    // Do NOT use --single: we want the full cascade + parallel publish path.
    const result = await runCmd([...PKGLAB_BIN, 'pub', '--force'], {
      cwd: wsRoot,
      env: backendEnv(backend),
      timeoutMs: 60_000,
    });

    if (result.exitCode !== 0) {
      console.error(`  [${backend}] publish attempt ${i + 1} failed (exit ${result.exitCode}):`);
      console.error(`    stdout: ${result.stdout.slice(0, 300)}`);
      console.error(`    stderr: ${result.stderr.slice(0, 300)}`);
      continue;
    }

    const isWarmup = i < PUBLISH_WARMUP;
    const label = isWarmup ? 'warmup' : `#${i - PUBLISH_WARMUP + 1}`;
    process.stdout.write(`  publish ${label}: ${fmtSec(result.durationMs)} (${fmtMs(result.durationMs)})\n`);

    if (!isWarmup) {
      times.push(result.durationMs);
    }
  }

  return times;
}

/**
 * Packument GET benchmark.
 *
 * Measures raw HTTP latency of fetching a package's metadata from the registry.
 * Uses @bench/shared (a package with dependencies) for a realistic packument size.
 */
async function benchPackumentGet(backend: Backend, packages: FixturePackage[]): Promise<number[]> {
  const times: number[] = [];

  // Make sure registry is up and has packages published
  await waitForRegistry(5000);

  // Pick a package that has deps for a more realistic packument
  const targetPkg = packages.find(p => p.name === '@bench/shared') ?? packages[0];
  const encodedName = encodeURIComponent(targetPkg.name).replace('%40', '@');

  // Verify the package exists in the registry first
  try {
    const checkResp = await fetch(`${REGISTRY_URL}/${encodedName}`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' },
    });
    if (!checkResp.ok) {
      await checkResp.text();
      console.error(
        `  [${backend}] packument for ${targetPkg.name} not found (${checkResp.status}), skipping benchmark`,
      );
      return times;
    }
    await checkResp.text();
  } catch (err) {
    console.error(`  [${backend}] could not verify packument for ${targetPkg.name}: ${err}`);
    return times;
  }

  console.log(`  target: ${targetPkg.name}`);

  for (let i = 0; i < PACKUMENT_RUNS; i++) {
    const t0 = performance.now();
    try {
      const resp = await fetch(`${REGISTRY_URL}/${encodedName}`, {
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
      const elapsed = performance.now() - t0;

      if (!resp.ok) {
        // consume body to avoid leaking
        await resp.text();
        console.error(`  [${backend}] packument GET #${i + 1} returned ${resp.status}`);
        continue;
      }
      // consume body
      await resp.text();
      times.push(elapsed);
    } catch (err) {
      const elapsed = performance.now() - t0;
      console.error(`  [${backend}] packument GET #${i + 1} error: ${err}`);
      times.push(elapsed);
    }
  }

  return times;
}

// ---------------------------------------------------------------------------
// Per-backend orchestrator
// ---------------------------------------------------------------------------

interface BackendResults {
  coldStart: Stats;
  publish: Stats;
  packumentGet: Stats;
  memoryIdleKb: number;
  memoryAfterPublishKb: number;
  packageCount: number;
}

async function runBackend(
  backend: Backend,
  wsRoot: string,
  packages: FixturePackage[],
): Promise<BackendResults | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Backend: ${backend}`);
  console.log('='.repeat(60));

  try {
    // Clean slate
    await pkglabDown(backend);
    await clearFingerprints();

    // Cold start
    console.log('\n-- Cold start --');
    const coldStartTimes = await benchColdStart(backend);

    // Ensure registry is up for the remaining benchmarks
    const upResult = await pkglabUp(backend);
    if (upResult.exitCode !== 0) {
      const ready = await waitForRegistry(5000);
      if (!ready) {
        console.error(`[${backend}] Could not start registry, skipping remaining benchmarks.`);
        await pkglabDown(backend);
        return null;
      }
    }

    // Measure idle memory before any work
    console.log('\n-- Memory (idle) --');
    const pidBeforePublish = await readPid();
    const memoryIdleKb = pidBeforePublish ? await readRssKb(pidBeforePublish) : 0;
    console.log(`  RSS idle: ${fmtMb(memoryIdleKb)}`);

    // Publish latency (multi-package, parallel)
    console.log(`\n-- Publish latency (${packages.length} packages, parallel) --`);
    const publishTimes = await benchPublish(backend, wsRoot);

    // Packument GET latency
    console.log('\n-- Packument GET latency --');
    const packumentTimes = await benchPackumentGet(backend, packages);

    // Memory after publishes
    console.log('\n-- Memory (after publishes) --');
    const pidAfterPublish = await readPid();
    const memoryAfterPublishKb = pidAfterPublish ? await readRssKb(pidAfterPublish) : 0;
    console.log(`  RSS after publish: ${fmtMb(memoryAfterPublishKb)}`);

    // Shut down
    await pkglabDown(backend);

    return {
      coldStart: computeStats(coldStartTimes),
      publish: computeStats(publishTimes),
      packumentGet: computeStats(packumentTimes),
      memoryIdleKb,
      memoryAfterPublishKb,
      packageCount: packages.length,
    };
  } catch (err) {
    console.error(`[${backend}] Fatal error: ${err}`);
    await pkglabDown(backend).catch(() => {});
    return null;
  }
}

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------

function printTable(results: Partial<Record<Backend, BackendResults | null>>): void {
  // Get package count from any available result
  const anyResult = results.verbunccio;
  const packageCount = anyResult?.packageCount ?? FIXTURE_PACKAGE_COUNT;

  console.log('\n');
  console.log('Registry Benchmark Results');
  console.log('-'.repeat(80));
  console.log('');

  const r = results.verbunccio;
  if (!r) {
    console.log('No results.');
    return;
  }

  const header = `| Metric                  | p50              | p95              | min/max                |`;
  const sep = '|' + '-'.repeat(25) + '|' + '-'.repeat(18) + '|' + '-'.repeat(18) + '|' + '-'.repeat(24) + '|';
  console.log(header);
  console.log(sep);

  const detailRows: { metric: string; stats: Stats; format: (v: number) => string }[] = [
    { metric: 'Cold start', stats: r.coldStart, format: fmtMs },
    { metric: `Publish (${packageCount} pkgs)`, stats: r.publish, format: fmtMs },
    { metric: 'Packument GET', stats: r.packumentGet, format: fmtMs },
  ];

  for (const dr of detailRows) {
    const line = `| ${dr.metric.padEnd(23)} | ${dr.format(dr.stats.p50).padEnd(16)} | ${dr.format(dr.stats.p95).padEnd(16)} | ${dr.format(dr.stats.min)} / ${dr.format(dr.stats.max)} |`;
    console.log(line);
  }

  console.log(
    `| ${'Memory idle (RSS)'.padEnd(23)} | ${fmtMb(r.memoryIdleKb).padEnd(16)} | ${''.padEnd(16)} | ${''.padEnd(22)} |`,
  );
  console.log(
    `| ${'Memory after pub (RSS)'.padEnd(23)} | ${fmtMb(r.memoryAfterPublishKb).padEnd(16)} | ${''.padEnd(16)} | ${''.padEnd(22)} |`,
  );

  // Print detailed stats
  console.log('');
  console.log('Detailed statistics:');
  console.log(
    `    Cold start:    p50=${fmtMs(r.coldStart.p50)}, p95=${fmtMs(r.coldStart.p95)}, min=${fmtMs(r.coldStart.min)}, max=${fmtMs(r.coldStart.max)}, n=${r.coldStart.samples}`,
  );
  console.log(
    `    Publish:       p50=${fmtMs(r.publish.p50)}, p95=${fmtMs(r.publish.p95)}, min=${fmtMs(r.publish.min)}, max=${fmtMs(r.publish.max)}, n=${r.publish.samples}`,
  );
  console.log(
    `    Packument GET: p50=${fmtMs(r.packumentGet.p50)}, p95=${fmtMs(r.packumentGet.p95)}, min=${fmtMs(r.packumentGet.min)}, max=${fmtMs(r.packumentGet.max)}, n=${r.packumentGet.samples}`,
  );
  console.log(`    Memory idle:   ${fmtMb(r.memoryIdleKb)}`);
  console.log(`    Memory post:   ${fmtMb(r.memoryAfterPublishKb)}`);
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

async function writeJsonResults(results: Partial<Record<Backend, BackendResults | null>>): Promise<string> {
  const timestamp = Date.now();
  const outPath = join(import.meta.dir, `results-${timestamp}.json`);

  const output: Record<string, unknown> = {
    timestamp,
    date: new Date(timestamp).toISOString(),
    config: {
      port: PORT,
      coldStartRuns: COLD_START_RUNS,
      publishRuns: PUBLISH_RUNS,
      publishWarmup: PUBLISH_WARMUP,
      packumentRuns: PACKUMENT_RUNS,
      fixturePackageCount: FIXTURE_PACKAGE_COUNT,
    },
    results: {},
  };

  for (const [backend, r] of Object.entries(results)) {
    if (!r) {
      (output.results as Record<string, unknown>)[backend] = null;
      continue;
    }
    (output.results as Record<string, unknown>)[backend] = {
      coldStart: r.coldStart,
      publish: r.publish,
      packumentGet: r.packumentGet,
      memoryIdleKb: r.memoryIdleKb,
      memoryAfterPublishKb: r.memoryAfterPublishKb,
      packageCount: r.packageCount,
    };
  }

  await Bun.write(outPath, JSON.stringify(output, null, 2) + '\n');
  return outPath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { backends } = parseArgs();

  console.log('Registry Benchmark');
  console.log(`Backends: ${backends.join(', ')}`);
  console.log(`Port: ${PORT}`);
  console.log(`Fixture packages: ${FIXTURE_PACKAGE_COUNT}`);
  console.log(`Fixture dir: ${BENCH_DIR}`);
  console.log('');

  // Create fixtures
  console.log('Creating fixture workspace...');
  const { wsRoot, packages } = await createFixtures();
  console.log(`  workspace: ${wsRoot}`);

  const allResults: Partial<Record<Backend, BackendResults | null>> = {};

  try {
    for (const backend of backends) {
      const result = await runBackend(backend, wsRoot, packages);
      allResults[backend] = result;
    }

    // Print comparison table
    printTable(allResults);

    // Write raw JSON
    const jsonPath = await writeJsonResults(allResults);
    console.log(`\nRaw results written to: ${jsonPath}`);
  } finally {
    // Clean up fixtures
    console.log('\nCleaning up fixtures...');
    await cleanFixtures();
  }
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
