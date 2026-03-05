# Fix 20 Bugs Found by Multi-Agent Review (2026-03-05)

20 bugs found by 6 independent reviewers (5 Claude Opus agents + Codex gpt-5.3). Grouped into 5 batches for parallel implementation by 4 agents.

Run after every batch: `bun run test:e2e`

## Batch A: Consumer state + manifest correctness

Agent 1. Touches: `consumer.ts`, `add.ts`, `restore.ts`

### Task A1: Re-add overwrites original version in repo state (HIGH)

File: `src/commands/add.ts:361-371`

On re-add, `targets` is overwritten with `previousVersions` which contains the current pkglab version, not the real original. In the `else` branch (line 361), merge targets by `dir` key: preserve the existing `original` value if it exists and isn't empty. Only use `previousVersions` original for NEW dirs not already in state.

```typescript
// Instead of blindly overwriting:
// repoState.packages[pkg.name].targets = targets;
// Merge preserving originals:
const existing = repoState.packages[pkg.name].targets;
const newTargets = targets.map(t => {
  const prev = existing.find(e => e.dir === t.dir);
  return prev ? { ...t, original: prev.original || t.original } : t;
});
repoState.packages[pkg.name].targets = newTargets;
```

Risk: moderate (interacts with A5)

### Task A2: updatePackageJsonVersion only handles deps/devDeps (HIGH)

File: `src/lib/consumer.ts:213`

Expand iteration from `['dependencies', 'devDependencies']` to `['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']`. Same change for `removePackageJsonDependency` at line 236.

Risk: safe

### Task A3: removepkglabBlock finds MARKER_END from position 0 (HIGH)

File: `src/lib/consumer.ts:64`

Change `const endIdx = result.indexOf(MARKER_END)` to `const endIdx = result.indexOf(MARKER_END, startIdx + MARKER_START.length)`. If `endIdx === -1` after a valid `startIdx`, break to avoid infinite loop.

Risk: safe

### Task A4: removeRegistryFromNpmrc uses Bun.write instead of atomicWrite (MEDIUM)

File: `src/lib/consumer.ts:57`

Replace `await Bun.write(npmrcPath, content)` with `await atomicWrite(npmrcPath, content)`. `atomicWrite` is already imported from `./fs`.

Risk: safe

### Task A5: Repo state path mismatch between add and restore (MEDIUM)

File: `src/commands/restore.ts:42`

After `findRepoByPath(repoPath)` returns null, fallback: try `discoverWorkspace(process.cwd())` to get workspace root, then `findRepoByPath(workspaceRoot)`. Use the resolved `repo.state.path` for .npmrc cleanup at lines 147-149 instead of `repoPath`.

Risk: moderate

## Batch B: Catalog, fingerprint, and check fixes

Agent 2. Touches: `workspace.ts`, `fingerprint.ts`, `check.ts`. No overlap with Batch A.

### Task B1: loadCatalogs misses pnpm default catalog (HIGH)

File: `src/lib/workspace.ts:30-49`

After loading `content.catalogs`, also check `content.catalog` (singular). If it exists and is an object, add it as `result['default']`:

```typescript
if (content.catalog && typeof content.catalog === 'object') {
  result['default'] = content.catalog as Record<string, string>;
}
```

This makes `resolveCatalogProtocol` (publisher.ts:193) correctly find `catalogs['default']`.

Risk: safe

### Task B2: fingerprintPackageStrict hardcodes npm (HIGH)

File: `src/lib/fingerprint.ts:269`

Replace `run(['npm', 'pack', '--dry-run', '--json'], { cwd: packageDir })` with `run([process.execPath, 'pack', '--dry-run', '--json'], { cwd: packageDir, env: bunEnv() })`. Import `bunEnv` from `./proc`.

IMPORTANT: Verify `bun pack --dry-run --json` produces compatible output format. If not, use `bun pm pack --dry-run --json` or similar. If bun doesn't support this at all, keep npm but add a warning log when running in compiled mode. Check bun docs.

Risk: moderate (needs output format verification)

### Task B3: check command doesn't scan staged pnpm-workspace.yaml (HIGH)

File: `src/commands/check.ts`, after line 57

Add check for staged `pnpm-workspace.yaml`:

```typescript
if (staged.includes('pnpm-workspace.yaml')) {
  const showResult = await run(['git', 'show', ':pnpm-workspace.yaml'], { cwd });
  const { parse } = await import('yaml');
  const content = parse(showResult.stdout);
  // Check default catalog
  if (content?.catalog) {
    for (const [name, version] of Object.entries(content.catalog)) {
      if (typeof version === 'string' && ispkglabVersion(version)) {
        log.line(`  ${c.red('x')} Staged pnpm-workspace.yaml catalog.${name}: ${version}`);
        issues++;
      }
    }
  }
  // Check named catalogs
  if (content?.catalogs) {
    for (const [catName, entries] of Object.entries(content.catalogs)) {
      if (!entries || typeof entries !== 'object') continue;
      for (const [name, version] of Object.entries(entries as Record<string, string>)) {
        if (typeof version === 'string' && ispkglabVersion(version)) {
          log.line(`  ${c.red('x')} Staged pnpm-workspace.yaml catalogs.${catName}.${name}: ${version}`);
          issues++;
        }
      }
    }
  }
}
```

Risk: safe

## Batch C: Process and listener fixes

Agent 3. Touches: `proc.ts`, `daemon.ts`, `listener-daemon.ts`, `listener-core.ts`, `paths.ts`. No overlap with A or B.

### Task C1: Listener lock is global, not per-workspace (MEDIUM)

Files: `src/lib/listener-daemon.ts:100`, `src/lib/listener-ipc.ts` or `src/lib/paths.ts`

Add a helper to compute per-workspace lock path:

```typescript
export function getListenerLockPath(workspaceRoot: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(workspaceRoot).digest('hex').slice(0, 12);
  return join(paths.listenersDir, `${hash}.lock`);
}
```

In `ensureListenerRunning`, replace `paths.listenerLock` with `getListenerLockPath(workspaceRoot)`.

Risk: moderate

### Task C2: Listener daemon stderr pipe never drained (MEDIUM)

File: `src/lib/listener-daemon.ts:66-85`

Mirror `daemon.ts` pattern: start stderr reader before `Promise.race`, cancel on success, use collected text on error:

```typescript
const stderrReader = proc.stderr.getReader();
const stderrChunks: Uint8Array[] = [];
const stderrPromise = (async () => {
  try {
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      stderrChunks.push(value);
    }
  } catch {}
  return Buffer.concat(stderrChunks).toString();
})();
// ... after result === 'ready':
await stderrReader.cancel();
proc.unref();
// ... on error path:
const stderr = await stderrPromise;
```

Risk: moderate

### Task C3: startedAt timestamp skew (MEDIUM)

File: `src/lib/daemon.ts:72`

Capture `const startedAt = Date.now()` BEFORE spawning the process (before line 31). Write this pre-spawn timestamp to the PID file instead of `Date.now()` at line 72.

Risk: safe

### Task C4: Socket error handler doesn't clean up buffer (LOW)

File: `src/lib/listener-core.ts:229-233`

Add `socketBuffers.delete(_socket)` as first line in the `error` handler.

Risk: safe

### Task C5: validatePidStartTime Linux fallback always returns true (LOW)

File: `src/lib/proc.ts:133-137`

The simplest safe fix: remove the `/proc/{pid}/stat` existence check entirely and just return `false`. This forces the HTTP ping fallback in `daemon.ts` `validatePid`, which is cheap and correct.

```typescript
// Remove the Linux fallback block entirely
// (lines 133-137)
// The function already returns false at line 139
```

Risk: safe (conservative: forces ping check which is reliable)

## Batch D: Down command transactional safety

Sequential after Batches A+C complete (uses restore behavior from A, listener helpers from C).

### Task D1: Partial restore in down doesn't save intermediate state (MEDIUM)

File: `src/commands/down.ts:74-81`

Move `saveRepoByPath` inside the per-package loop:

```typescript
for (const name of pkgNames) {
  const link = repo.state.packages[name];
  await restorePackage(repoPath, name, link.targets, link.catalogName, link.catalogFormat);
  delete repo.state.packages[name];
  await saveRepoByPath(repo.state.path, repo.state);
}
```

Risk: safe (more disk I/O but ensures crash safety)

### Task D2: down command doesn't acquire publish lock (MEDIUM)

File: `src/commands/down.ts:70-108`

Wrap the restore loop with publish lock. Import `acquirePublishLock` or equivalent. The `--force` path should NOT acquire the lock (it's explicitly for bypassing coordination).

Risk: moderate

### Task D3: down only stops listener for current workspace (LOW)

File: `src/commands/down.ts:23-38`

Add `stopAllListeners()` in `listener-daemon.ts` that scans `paths.listenersDir` for `*.pid` files, reads each, and stops each listener. Call from `down` instead of single-workspace stop.

Risk: moderate

## Batch E: Publish pipeline consistency + performance

Agent 4. Touches: `pub.ts`, `publisher.ts`, `graph.ts`. No overlap with A/B/C.

### Task E1: Partial publish failure leaves dist-tags inconsistent (MEDIUM)

File: `src/commands/pub.ts:880-881`

Track successfully published packages via `onPackagePublished`. After `executePublish` (whether it throws or not), set dist-tags for successful packages, then re-throw:

```typescript
const successfulPackages: PublishEntry[] = [];
// in onPackagePublished: successfulPackages.push(entry);
// after executePublish try/catch:
if (successfulPackages.length > 0) {
  const distTag = tag ?? 'pkglab';
  await Promise.all(successfulPackages.map(e => setDistTag(config, e.name, e.version, distTag)));
}
```

Risk: moderate

### Task E2: runRepoInstall null access on state.packages (MEDIUM)

File: `src/commands/pub.ts:988-989`

Add null guard:

```typescript
for (const entry of repo.packages) {
  const link = repo.state.packages[entry.name];
  if (link) {
    link.current = entry.version;
  }
}
```

Risk: safe

### Task E3: Unbounded parallelism in executePublish (LOW)

File: `src/lib/publisher.ts:56`

Replace `Promise.allSettled(plan.packages.map(...))` with bounded concurrency (default 8, env `PKGLAB_PUBLISH_CONCURRENCY`):

```typescript
async function mapSettled<T, R>(
  items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
```

Risk: moderate

### Task E4: deterministicToposort uses O(n) queue.shift() (LOW)

File: `src/lib/graph.ts:207`

Replace with index-based approach: `let head = 0;` and `const node = queue[head++];` instead of `queue.shift()`.

Risk: safe

## Parallel Agent Assignment

```
Time -->  T0          T1 (after A+C)    T2
          +---------+ +-------+
Agent 1:  | Batch A | | Batch D |
          +---------+ +-------+
Agent 2:  | Batch B |
          +---------+
Agent 3:  | Batch C |
          +---------+
Agent 4:  | Batch E |
          +---------+
```

Batches A, B, C, E have no file overlap: 4 agents in parallel.
Batch D depends on A (restore behavior) and C (listener helpers): runs after both complete.

## Decisions Log

- Codex suggested `run([process.execPath, 'npm', 'pack', ...], { env: bunEnv() })` for B2. Won't work: `process.execPath` with `BUN_BE_BUN=1` acts as `bun`, not `npm`. Need to verify `bun pack --dry-run --json` compat first
- Codex suggested `ps -o etimes=` for Linux PID validation (C5). Simpler to just return `false` and force HTTP ping fallback. Going with the simpler approach
- Codex suggested wrapping `down --force` with publish lock too (D2). Disagree: `--force` is explicitly for bypassing coordination when things are stuck
- Both Claude and Codex agree on 4 parallel agents with Batch D sequential
- For E3 concurrency limit, Codex suggested 4, Claude suggested 8. Going with 8 (configurable via env). Each publish is a subprocess and the local registry handles it
- Old plan in this file covered 27 different bugs from a prior session. This plan supersedes it for the 20 bugs found in the 2026-03-05 multi-agent review. Some bugs overlap (e.g., atomic writes, pid validation) and those old tasks should be considered done if they match
