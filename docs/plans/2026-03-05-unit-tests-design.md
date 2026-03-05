# Unit Test Opportunities for pkglab

Analysis date: 2026-03-05
Sources: 3 Claude Opus agents (parallel codebase exploration) + Codex gpt-5.3 (independent analysis)

Runtime: `bun test`

## Approach

Phased rollout starting with pure, exported functions that need zero infrastructure. Each phase builds on the previous one, adding minimal extraction or mocking as needed.

## Phase 1: Pure exported functions (zero infrastructure)

These functions are already exported, have no side effects, and contain the most critical logic. Write tests immediately.

### `src/lib/graph.ts` (5 functions)

All functions are pure and exported. This file implements the cascade algorithm, the core of `pkglab pub`.

`buildDependencyGraph(packages)`
- Builds a `DepGraph` from workspace packages
- Merges dependencies, peerDependencies, optionalDependencies for intra-workspace edges
- Test: single package, no inter-deps, cycles, all three dep types, dep name exists vs not

`computeInitialScope(graph, targets, cachedDeps?)`
- Phase 1 cascade: targets + transitive deps
- Test: target not in graph, deep transitive deps, cached vs live path, shared deps across targets

`closeUnderDeps(graph, scope, cachedDeps?)`
- Iterative scope expansion until stable
- Test: already closed, private packages don't pull deps, multiple iterations needed, empty scope

`expandDependents(graph, changed, scope, consumed?, cached?)`
- Phase 2 cascade: dependent expansion with consumer filtering
- Test: no consumedPackages (no filter), consumed excludes some, already-in-scope not counted as new, skippedDependents excludes private, cycle throws CycleDetectedError

`deterministicToposort(graph, subset)`
- Kahn's algo with lexical tie-breaking and cycle fallback
- Test: single node, linear chain, diamond dep, lexical ordering on tie, cycle fallback, empty subset, missing node

### `src/lib/version.ts` (4 functions)

All pure and exported. Version parsing/generation underpins pub/add/restore.

`ispkglabVersion(version)`
- Test: valid untagged `0.0.0-pkglab.123`, valid tagged `0.0.0-pkglab-feat1.123`, non-pkglab `1.0.0`, prefix-only `0.0.0-pkglab`

`extractTimestamp(version)`
- Test: valid versions, no dot returns NaN, non-numeric suffix, old date format

`extractTag(version)`
- Test: untagged returns null, non-pkglab returns null, tagged returns tag, tag with hyphens

`sanitizeTag(raw)`
- Test: `feat/my-feature` -> `feat-my-feature`, all-special-chars throws, 50-char truncation, double hyphens collapse, leading/trailing hyphens removed, empty-after-sanitize throws

### `src/commands/pub.ts` - `detectChanges()`

Core change classification logic. Already a standalone function.

- Test: no previous state -> changed, hash mismatch -> changed, matching hash + no changed deps -> unchanged, matching hash + changed dep -> propagated, matching hash + propagated dep -> propagated, topo ordering matters

### `src/lib/args.ts` - `normalizeScope(input)`

Already exported, simplest possible test target.

- Test: `"clerk"` -> `"@clerk/"`, `"@clerk"` -> `"@clerk/"`, `""` -> null, `"@clerk/pkg"` -> null

### `src/lib/publisher.ts` - `buildPublishPlan()`

Exported. Dep-rewriting logic across dep fields.

- Test: in-scope deps rewritten to new version, existingVersions reused, all dep field types, empty packages list

### `src/lib/consumer.ts` - `removepkglabBlock(content)` and `findCatalogEntry(data, pkgName)`

Both exported, both pure.

`removepkglabBlock`: test multiple markers, `\n{3,}` normalization, trimming
`findCatalogEntry`: test package in `catalog`, in named `catalogs`, not found

### `src/lib/repo-state.ts` - `repoFileName(path)`

Exported, pure. SHA-256 hash + last-50-chars truncation.

- Test: short path, 50-char exact, over 50 (takes last 50), determinism

## Phase 2: Export private pure functions, then test

These are pure in behavior but currently unexported. Requires adding `export` keyword (one-line change per function).

### `src/commands/add.ts`

`parsePackageArg(str)` - parses `@scope/pkg@tag`
- Test: scoped no tag, scoped with tag, unscoped with tag, trailing `@`, empty tag

`resolveFromDistTags(name, distTags, tag?)` - tag resolution
- Happy-path testable. Error paths use `process.exit` (skip or mock)

### `src/lib/lockfile-patch.ts`

`replaceIntegrity(content, name, version, newIntegrity)` - windowed string replacement
- Test: key not found, integrity missing in window, closing `}` missing, happy path, scoped package name, window boundary

`replaceAll(source, search, replacement)` - split/join replace
- Test: no match, single match, multiple matches, regex special chars in search

### `src/lib/fingerprint.ts`

`collectExportPaths(node, out)` - recursive exports field walker
- Test: string `./dist/index.js`, string without `./`, array, nested object, deeply nested, null values

`fileStatsMatch(cached, current)` - element-wise array comparison
- Test: identical, different lengths, same length different path/mtime/size, empty arrays

### `src/lib/verbunccio-routes.ts`

`mergePackuments(upstream, local, name, port)` - packument merge with URL rewriting
- Test: local versions override upstream, tarball URLs rewritten, dist-tags merged, time merged

`safeDecode(raw)` - path traversal validation
- Test: `..` rejected, backslash rejected, null byte rejected, invalid percent sequences, valid names pass

`bumpRev(currentRev?)` - revision increment
- Test: undefined -> `"1-verbunccio"`, `"3-verbunccio"` -> `"4-verbunccio"`, malformed -> `"1-verbunccio"`

### `src/lib/publisher.ts`

`resolveWorkspaceProtocol(spec)` - workspace protocol normalization
- Test: `workspace:^`, `workspace:~`, `workspace:*`, `workspace:^1.2.3`

`resolveCatalogProtocol(spec, pkgName, catalogs)` - catalog lookup
- Test: found in catalog, not found falls back to `*`, warning logged

## Phase 3: Extract inline logic, then test

These need logic extraction from command run() bodies or module-level state refactoring.

### `src/commands/check.ts` - localhost URL counter

Extract to `countLocalhostUrls(content: string): number`
- Test: no matches, one 127.0.0.1, one localhost, mixed, adjacent

### `src/lib/publish-queue.ts` - coalescing state machine

Refactor module-level state into a class:
```
class PublishQueue {
  enqueue(req): QueueResult
  getStatus(): WorkspaceStatus[]
}
```
- Test: two rapid pings coalesce, flags OR correctly, debounce resets

### `src/lib/listener-core.ts` - frame parser

Extract `parseFrames(buffer: string): { frames: string[], remainder: string }`
- Test: single frame, multiple frames, partial frame, empty buffer

### `src/lib/prune.ts` - version selection

Extract `selectVersionsToRemove(versions, keepCount, referenced, onlyTag?): string[]`
- Test: keep count respected, referenced excluded, tag filtering, empty versions

## Implementation plan

Test file convention: `src/lib/__tests__/<module>.test.ts` and `src/commands/__tests__/<module>.test.ts`

Order of implementation:
1. `version.test.ts` - simplest, highest signal-to-noise
2. `args.test.ts` - one function, trivial
3. `graph.test.ts` - most complex, highest value
4. `pub-detect-changes.test.ts` - core cascade decision logic
5. `consumer.test.ts` - removepkglabBlock + findCatalogEntry
6. `publisher.test.ts` - buildPublishPlan
7. `repo-state.test.ts` - repoFileName
8. Phase 2 functions (export + test)
9. Phase 3 extractions (refactor + test)

## Decisions log

- Bun's built-in test runner over vitest/jest: pkglab already uses Bun runtime, zero config needed
- `__tests__/` subdirectories over co-located `.test.ts`: keeps source directories clean, matches common Bun project conventions
- Phase 1 before Phase 2/3: maximize test coverage with zero refactoring first, defer extraction work
- Skip testing trivial functions (getPositionalArgs, findPackage, paths.ts constants, color.ts wrappers): not worth the maintenance cost
- `process.exit` error paths deferred: testing happy paths first, error path mocking is Phase 2+ work
- Codex recommended starting with graph + version + detectChanges; Claude agents converged on the same top 3. No disagreement across models on priority ordering
