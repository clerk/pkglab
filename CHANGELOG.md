# pkglab

## 0.15.0

### Minor Changes

- 6df3141: Automatically prune consumer repos whose directories no longer exist on disk instead of crashing with ENOENT. Any command that accesses saved repos (pub, down, up, doctor, repo ls, etc.) now detects missing directories and removes the stale repo state, logging a warning.

## 0.14.0

### Minor Changes

- aed833c: Stop hiding .npmrc with skip-worktree so it appears in git status. Pre-commit check now only errors if .npmrc with pkglab markers is actually staged, not just present on disk.

## 0.13.3

### Patch Changes

- 94ec904: Fix race condition when multiple processes call pub or add concurrently with the daemon not running

## 0.13.2

### Patch Changes

- c650f2e: Fix wrapper shim failing when pnpm skips optionalDependencies. The bin wrapper now falls back to a global `pkglab` binary in PATH when the platform-specific package is missing, instead of erroring immediately.

## 0.13.1

### Patch Changes

- 9263e60: Fix install failing when pkglab runs inside a pnpm script chain. pnpm injects `npm_config_registry` into child processes, which overrides the `.npmrc` that pkglab writes. The install subprocess now explicitly sets `npm_config_registry` to the local registry URL.
- 290978c: Fix daemon health check failing on Linux by adding HTTP ping fallback when `ps` date parsing fails. Bun uses JavaScriptCore which may not parse `ps -o lstart=` output on all platforms.

## 0.13.0

### Minor Changes

- 82f3cc9: Remove Verdaccio dependency and use the built-in registry server exclusively. Storage directory migrates automatically from `~/.pkglab/verdaccio/` to `~/.pkglab/registry/`. Drops `verdaccio` and `libnpmpublish` from dependencies.

### Patch Changes

- 4c7ea51: Use BUN_BE_BUN=1 for publishing instead of requiring external bun in PATH
- 0ea62cf: Require bun in PATH for publishing in compiled mode (no npm fallback)

## 0.12.2

### Patch Changes

- b790438: Fix subprocess spawning in compiled binary: use resolveRuntime() for bun/npm commands instead of process.execPath

## 0.12.1

### Patch Changes

- 4d4eb76: Use process.execPath instead of hardcoded 'bun' for subprocess spawning, so the compiled binary works on systems without Bun installed.

## 0.12.0

### Minor Changes

- 30c9609: Add `--health` flag to `pkglab status` for scripting (exits 0/1 silently)

### Patch Changes

- 07cc139: Add 150ms debounce to publish pings so rapid-fire requests coalesce into a single publish batch
- 584db22: Document publish ping debounce behavior in README
- 72a408e: Fix race condition where lockfile integrity fetch was cached across consumer repos, causing stale results when an earlier repo triggered the fetch before all packages were published

## 0.11.1

### Patch Changes

- dec4094: Fix publish auth by passing NPM_CONFIG_TOKEN env var to bun publish instead of writing .npmrc files. The previous approach used unsupported npm_config env vars, causing "missing authentication" errors in CI.
- 34b0e2a: Stop writing .npmrc to publisher workspace root during pub. Auth token is now passed via env var to bun publish instead of creating/restoring a temporary .npmrc file.

## 0.11.0

### Minor Changes

- ff3f9ae: Lockfile safety: prevent localhost registry URLs from leaking into commits

  - `pkglab check` now scans staged lockfiles (bun.lock, bun.lockb, pnpm-lock.yaml) for localhost registry URLs
  - `pkglab add` auto-injects `pkglab check` into pre-commit hooks (Husky, raw git), removed on restore
  - `pkglab down` restores all consumer repos before stopping the daemon, use `--force` to skip
  - `pkglab doctor` detects dirty state and gains `--lockfile` flag to sanitize bun.lock files
  - After pkglab-managed bun installs, bun.lock is post-processed to strip localhost URLs

## 0.10.0

### Minor Changes

- 40caa09: Redirect registry worker output to log file so `pkglab logs -f` shows pings and publish events. Fix pnpm lockfile patching for monorepo sub-package consumers by walking up to find pnpm-lock.yaml. Add lockfile patch status to pub spinner output.

## 0.9.0

### Minor Changes

- 8d14a02: Replace Unix socket IPC with HTTP endpoint on registry server. Publish coalescing now runs inside the Verbunccio process via POST /-/pkglab/publish. The listen command shows a deprecation notice and queue status. Old listener files kept for now.
- e8ce241: Patch pnpm lockfiles directly to skip resolution during consumer updates. For pnpm consumers, pkglab now replaces version strings and integrity hashes in pnpm-lock.yaml, then runs `pnpm install --frozen-lockfile` to skip the expensive dependency resolution phase. Falls back to regular install if patching fails. Only affects pnpm consumers.
- e5cb54c: Performance optimizations for pub command: mtime-gated fingerprinting skips content hashing when files are unchanged, graph pass-through eliminates redundant dependency graph rebuilds, per-phase timing instrumentation (visible with --verbose), and --prefer-offline for pnpm/bun consumer installs.

### Patch Changes

- 6e37608: Skip lifecycle scripts during consumer installs for faster updates. All package managers now use `--ignore-scripts` by default, with automatic fallback to a full install if it fails.
- 4d87ec4: Fix lockfile patching for pnpm consumers with transitive pkglab dependencies. Previously, integrity hashes were only updated for directly tracked packages, causing ERR_PNPM_TARBALL_INTEGRITY errors when the lockfile also contained pkglab packages pulled in as transitive dependencies. Now builds patch entries from all published packages so every pkglab package in the lockfile gets its integrity hash updated.

## 0.8.0

### Minor Changes

- 9537b1f: Replace Verdaccio with a lightweight Bun.serve() registry server (Verbunccio) as the default backend. The new registry holds package metadata in memory with write-through persistence to disk, proxies unknown packages to npmjs.org, and merges local versions with upstream packuments so non-pkglab versions still resolve correctly.

  Key improvements over Verdaccio: 6x faster cold start (59ms vs 335ms), 3x faster parallel publish for 22 packages (1.06s vs 3.5s), sub-millisecond packument lookups from memory, and 66% lower memory usage (44MB vs 128MB idle).

  The legacy Verdaccio backend is still available via PKGLAB_VERDACCIO=1.

## 0.7.0

### Minor Changes

- 8f4f3ae: Add per-repo lifecycle hooks system. Consumer repos can place executable scripts in `.pkglab/hooks/` to run custom logic at key moments: before/after add, restore, and publish-triggered updates. Hooks receive a typed JSON payload as argv[1] with package details, registry URL, and event info. Includes `pkglab hooks init` to scaffold the hooks directory with type definitions and example stubs.

### Patch Changes

- e09da5e: Use CHANGELOG.md for GitHub release notes instead of auto-generated notes

## 0.6.2

### Patch Changes

- 31e4c61: Fix release workflow tag push using explicit tag ref instead of --follow-tags

## 0.6.1

### Patch Changes

- e2ed76b: Show skipped dependents in pub scope summary when there are no active repos

## 0.6.0

### Minor Changes

- 2122a8e: Forward --force, --single, --shallow, --dry-run flags through --ping to listener daemon. Add oxlint and oxfmt tooling with CI checks.

### Patch Changes

- 776d0fc: Change default Verdaccio port from 4873 to 16180 to avoid conflicts with existing Verdaccio instances.

## 0.5.0

### Minor Changes

- 85fa35d: Auto-start listener daemon on `pub --ping`, show listener in status/logs/down
- 987b5be: Add `pkglab listen` command and `pub --ping`, `pub --root` flags for coordinated watch-mode publishing
- 810ce0a: Stream consumer repo updates during publish instead of waiting for all packages

### Patch Changes

- 0299038: Deduplicate daemon lifecycle helpers, repo activation logic, and install runner across commands
- fe1a74b: Retry failed bun publish attempts up to 3 times with backoff

## 0.4.0

### Minor Changes

- c715071: Publish packages in-place instead of copying to a temp directory, reducing publish time for all Clerk packages from ~11s to ~1s. Original package.json is renamed to package.json.pkglab during publish and restored in a finally block. If a crash interrupts the restore, the next pub auto-recovers and doctor detects leftovers.

  Also: switch config and repo state from YAML to JSON, add --scope/--tag/--dry-run/--verbose flags to restore, add --all to repo on/off, shared arg utilities, dead code removal, and various CLI consistency fixes.

### Patch Changes

- 9359b55: Performance optimizations: stream file hashing instead of loading into memory, precompute graph transitive closures, fingerprint all packages upfront in one batch, cache workspace discovery in add --scope. Also adds a "Published N packages in X.XXs" timing log to pub output.

## 0.3.0

### Minor Changes

- be577d5: Support multiple paths in `pkglab repo on/off` and update README quickstart with scope, workspace scanning, and repo management examples

## 0.2.0

### Minor Changes

- 1880a68: Auto-detect catalog entries when adding packages: pkglab add now checks if a package exists in a workspace catalog and automatically uses catalog mode, removing the need for the --catalog flag in most cases
- d5d1454: Unify consumer install path: upsert packages into package.json and always use `pm install` instead of branching between `pm add` and `pm install`
- 5274336: Auto-detect workspace sub-packages when adding packages: `pkglab add` now scans all workspace packages for the dependency and updates all of them. Use `-p` to opt out and target a single sub-package. Restore handles multi-target. Internal state format changed to use a targets array per package.
- 10f875e: Add pnpm catalog support: `--catalog` flag now works with pnpm workspaces that define catalogs in pnpm-workspace.yaml, in addition to bun/npm catalogs in package.json
- ff261a9: Add `--scope` and `--tag` flags to `pkglab add`. `--scope clerk` (or `--scope @clerk`) scans the workspace for all dependencies matching `@clerk/*`, verifies they are all published, and replaces them in one command. `--tag feat1` applies a tag to all packages at once (equivalent to the inline `@tag` syntax). Both flags can be combined: `pkglab add --scope clerk --tag feat1`.

### Patch Changes

- 8d6e166: Add E2E tests for nested package install (-p flag) and bun catalog support (--catalog flag)

## 0.1.1

### Patch Changes

- f5ef3f0: Fix npm publish failing on npm 11 by adding required --tag flag for prerelease versions

## 0.1.0

### Minor Changes

- c75f655: Identify consumer repos by filesystem path instead of package.json name. Repo state files now use a deterministic hash-based filename derived from the path, so renaming a package.json no longer orphans the repo. Display names are read from package.json at runtime. Existing repo files are auto-migrated on first use. The `repo rename` command has been removed since there is no stored name to rename.

### Patch Changes

- 7a13feb: Fix crash on machines without bun in PATH. The prune subprocess was spawning `bun` directly, which fails on systems that only have the compiled binary. Now uses `process.execPath` with a hidden `--__prune` flag, matching the existing daemon pattern.
