<p align="center">
  <a href="https://clerk.com?utm_source=github&utm_medium=clerk_pkglab" target="_blank" rel="noopener noreferrer">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://images.clerk.com/static/logo-dark-mode-400x400.png">
      <img src="https://images.clerk.com/static/logo-light-mode-400x400.png" height="64">
    </picture>
  </a>
  <br />
</p>
<div align="center">
  <h1>
    pkglab
  </h1>
  <a href="https://www.npmjs.com/package/pkglab">
    <img alt="Downloads" src="https://img.shields.io/npm/dm/pkglab" />
  </a>
  <a href="https://clerk.com/discord">
    <img alt="Discord" src="https://img.shields.io/discord/856971667393609759?color=7389D8&label&logo=discord&logoColor=ffffff" />
  </a>
  <a href="https://twitter.com/clerkdev">
    <img alt="Twitter" src="https://img.shields.io/twitter/url.svg?label=%40clerkdev&style=social&url=https%3A%2F%2Ftwitter.com%2Fclerkdev" />
  </a>
  <br />
  <br />
</div>

Local package development CLI with a built-in registry. Publish workspace packages locally and auto-update consumer repos.

Test your library changes in consumer repos the way your users actually install them. pkglab runs a fast Bun-based local npm registry, auto-publishes packages (and their deps/dependent chain) on every edit, and updates all your consumer repos automatically. No `npm link` symlink issues, no manual version juggling.

Built for teams publishing npm packages from monorepos who need to test changes in consumer repos before shipping. Used in production by the [Clerk JavaScript SDK](https://github.com/clerk/javascript) monorepo (22+ packages).

Also available as `pkgl` for short (so efficient ✨).

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Quick start - monorepo edition](#quick-start---monorepo-edition)
- [Install](#install)
- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Commands](#commands)
- [Multi-worktree support](#multi-worktree-support)
- [Catalog support](#catalog-support)
- [How versioning works](#how-versioning-works)
- [Design decisions](#design-decisions)
- [Configuration](#configuration)
- [Repo hooks](#repo-hooks)
- [Performance](#performance)
- [Safety](#safety)
- [Acknowledgments](#acknowledgments)

## Features

Core workflow

- Real `bun publish` to a local npm registry, so you test the same install your users get
- Automatic consumer repo updates after every publish
- Content-aware publishing: unchanged packages are skipped automatically, only packages with real changes (or whose deps changed) get a new version
- Dependency cascade awareness (change a shared util, all dependent packages get republished)
- Consistent across runs: on each `pub` invocation, `pkglab` picks the publish strategy that gives your consumer repos all changes without mismatched package versions

Performance

- Fast, lightweight registry built on `Bun.serve()` with in-memory metadata: starts in ~60ms, uses ~44MB RAM, publishes 22 packages in <1s
- Fast consumer installs: lockfile patching for pnpm (skips resolution), `--ignore-scripts` + `--prefer-offline` for bun/pnpm, automatic fallback on failure
- Automatic version pruning per tag so the local registry doesn't grow forever
- Sync and async APIs (`pub` and `pub --ping`), automatic debounce on rapid build-to-publish loops (common in big monorepos).

Multi-worktree and parallel development

- Publish from multiple git worktrees in parallel without version conflicts, each worktree gets its own version channel
- Works with most consumer package managers: npm, pnpm, or bun. Yarn works but not tested.

Safety and git hygiene

- Pre-commit safety checks (`pkglab check`) to catch local artifacts before they reach your repo, including lockfile scanning for localhost URLs
- Automatic pre-commit hook injection on first `pkglab add`, removed on restore
- Pre-commit hook protection on `.npmrc` so localhost registry URLs don't leak into commits
- Lockfile sanitization: auto-strips localhost registry URLs from `bun.lock` after installs, preventing CI breakage if the lockfile gets committed

## Quick start

```bash
# Globally install the binaries
npm install -g pkglab

# Publish packages from your library monorepo
pkglab pub # all (from workspace root), or current (if inside package)
pkglab pub @clerk/backend # specific package and cascade

# From a consumer repo, install a package from the local registry
# Run from workspace root to auto-update all sub-packages that use it
pkglab add # interactive prompt
pkglab add <name> # specific package
pkglab add <name> -p apps/dashboard # target a single sub-package instead
pkglab add --scope clerk # Or replace all packages of a scope at once

# Manage which consumer repos receive auto-updates
pkglab repo on              # interactive picker
pkglab repo on <path>       # specific repo
pkglab repo off             # interactive picker

# Make changes to the library, then re-publish
# Fingerprints each package, skips unchanged ones, cascades through deps and dependents
# Active consumer repos update automatically (see Design decisions for details)
pkglab pub

# When done, restore original versions
pkglab restore @clerk/backend                # one package
pkglab restore @clerk/backend @clerk/shared  # multiple packages
pkglab restore --all                         # everything in this repo

# Stop the registry
pkglab down
```

## Quick start - monorepo edition

If your packages have a watch/dev mode (tsup, tsc, rspack, etc.), you can wire pkglab into the workflow so rebuilds automatically publish to the local registry.

The manual workflow: run your dev server in one package, run `pkglab pub` from the root workspace (or `pkglab pub --root` from any sub workspace) in another when you want to push changes. Since pkglab fingerprints each package, only the ones with actual changes get republished.

When multiple packages rebuild at once, the registry server batches them into a single publish cycle instead of separate ones. Pings are debounced with a 150ms window: if several `pub --ping` requests arrive in quick succession (common when a build tool triggers rebuilds across packages), they're collected into one batch before publishing starts. Each tag gets its own queue lane, so worktree publishes don't interfere. The coalescing logic runs inside the registry process, so no separate listener is needed.

For a fully automated loop, wire `pub --ping` into your dev server's success hook:

```bash
# Watch builds with auto-publish on each successful rebuild
pnpm dev -- --onSuccess 'pkglab pub --ping'
```

Most dev servers have some kind of `onSuccess` hook you can run `pkglab pub --ping` in, for example, `tsup` & `tsdown` are using `onSuccess`, so each change would trigger a `dev build -> pkglab pub --ping -> package publishing` automatically.

You can also wire `pub --ping` into your build runner so publishes happen automatically after every rebuild. For example, with turbo's `--on-complete` hook:

```bash
turbo dev --on-complete 'pkglab pub --ping'
```

For a real-world example, we use this workflow in the [Clerk JavaScript SDK monorepo](https://github.com/clerk/javascript).

## Install

Prebuilt binaries (no runtime needed):

```
npm install -g pkglab
```

This installs a native binary for your platform. No Bun or Node.js runtime required to run pkglab itself. npm is only used here as a distribution channel.

Under the hood, the `pkglab` npm package contains a tiny Node.js wrapper. It declares platform-specific packages (`pkglab-darwin-arm64`, `pkglab-linux-x64`, etc.) as optional dependencies with `os` and `cpu` constraints, so npm only downloads the one matching your machine. When you run `pkglab`, the wrapper resolves the platform binary and execs it. The compiled binary has the Bun runtime embedded, so nothing else needs to be installed.

Your consumer repos can use any package manager: npm, pnpm, yarn, or bun.

Supported on macOS (ARM64, x64) and Linux (x64, ARM64).

## The problem

Testing local package changes across repos is painful. The existing tools all have real problems.

`npm link` creates symlinks into your source directory. React, styled-components, and other libraries that rely on module identity get duplicated: your app loads one copy from `node_modules` and the linked package resolves a second copy from its own `node_modules`. This causes the classic "hooks can only be called inside the body of a function component" crash, broken contexts, and `instanceof` checks failing across the boundary. A single `npm install` can also silently blow away your links. There are no lock file entries, so your CI and teammates can't reproduce the setup.

`yalc` improves on this by copying files, but it injects `.yalc` directories and modifies `package.json` with `file:` references that behave differently from real registry installs. Lock files end up with local paths instead of registry URLs. The install you test against is structurally different from what your users will get.

`workspace:^` and `workspace:~` protocols only work within a single workspace. If you need to test a package in a separate consumer repo (the common case), they can't help. Even within a workspace, packages resolve to local copies during install rather than going through the registry, which can mask version resolution bugs that only surface in real published installs. There's also a subtler problem: during snapshot or canary releases, `workspace:^` gets resolved to caret ranges like `^3.0.0-snapshot.xxx`. Semver compares pre-release identifiers lexicographically, so a caret range from one release channel can accidentally match versions from a completely different channel. For example, `^3.0.0-canary.v20251211` will match `3.0.0-snapshot.v20251204` because `snapshot` sorts after `canary`, even though that snapshot is older and from a different release channel entirely.

`pnpm overrides` and `yarn resolutions` require editing the consumer's `package.json`, remembering to undo before committing, and don't auto-update when you change the library. When pointed at local or workspace targets, they bypass registry validation, so you can miss broken exports maps, missing files in the `"files"` array, and unresolved `workspace:` / `catalog:` protocols until you actually publish to npm.

A standalone registry gives you half the picture, but you still have to manage the daemon lifecycle, generate versions, manually install in every consumer, track which repos are linked, prune old versions, and protect against committing localhost URLs.

`pkglab` solves all of this by publishing to a real npm registry running on your machine, and ships its own lightweight registry server that starts faster and uses less memory.

## How it works

`pkglab` runs a lightweight npm registry as a background daemon, built on `Bun.serve()` with in-memory package metadata and write-through persistence to disk. Unknown packages are proxied to the upstream npmjs.org registry, so consumer installs work transparently for both local and public packages.

When you publish, packages go through a real `bun publish` to this local registry. Exports maps, bundled dependencies, the `"files"` array, all validated through the same publish flow your users will get. Consumer repos install from this registry with a standard `npm install` / `pnpm add`, producing the same `node_modules` tree your users will get. One copy of React. Correct peer dependency resolution. Real lock file entries.

On top of that, `pkglab` handles automatic consumer updates, dependency cascading, parallel publishes with rollback, `.npmrc` protection, pre-commit checks, version pruning, and multi-worktree tag isolation. See [Features](#features) for the full list.

The registry server starts in ~60ms, uses ~44MB of memory, and publishes 22 packages in about 1 second. See [Performance](#performance) for full benchmark results.

## Commands

Registry

- `pkglab up` - start the local registry. Deactivates repos from the previous session, then offers a picker to reactivate the ones you need.
- `pkglab down` - stop the registry. Restores all consumer repos first (versions, `.npmrc`, pre-commit hooks) and only stops the daemon if all restores succeed. If a restore fails, the daemon stays up so you can fix the issue.
  - `--force`/`-f` - skip restoration and stop immediately
- `pkglab status` - show whether the registry is running and on which port.
  - `--health` - exit 0 if registry is healthy, exit 1 if not (silent, for scripting)
- `pkglab logs` - tail registry logs. `-f` for follow mode.
  - `--listener` - show only listener logs
  - `--registry` - show only registry logs
  - `--raw` - show raw JSON without pretty formatting

Publishing

- `pkglab pub [name...]` - publish packages to the local registry. Accepts multiple names. Publishes the current package (if inside one) or all public packages from the workspace root. Computes transitive dependents and republishes the cascade, including sibling workspace deps of dependents. Fingerprints each package and skips unchanged ones: only packages with content changes or whose deps changed get a new version. Uses mtime+size metadata to skip content hashing on repeat runs. Auto-updates active consumer repos matching the same tag and prunes old versions in the background.
  - `--tag <name>`/`-t` - publish with a tag
  - `--worktree`/`-w` - auto-detect tag from branch name
  - `--root` - publish all packages regardless of cwd
  - `--ping` - send publish request to the registry server instead of publishing directly
  - `--single` - skip cascade and fingerprinting
  - `--shallow` - targets + deps only, no dependent expansion
  - `--force`/`-f` - ignore fingerprints, republish all
  - `--no-pm-optimizations` - skip lockfile patching and install optimizations, uses plain `pm install`
  - `--dry-run` - preview what would be published
  - `--verbose`/`-v` - includes per-phase timing
- `pkglab listen` - (deprecated) shows queue status from the registry. Publish coalescing is now built into the registry server.

Consumer packages

- `pkglab add [name[@tag]...]` - install pkglab packages in the current repo. Accepts multiple names, batch installs in one command. Configures `.npmrc` and installs using your repo's package manager. No args for an interactive picker. Auto-detects catalog entries and updates the catalog source directly (see [Catalog support](#catalog-support)). In a workspace, auto-scans all sub-packages for the dependency and updates all of them (sub-packages using `catalog:` protocol are skipped, handled by catalog auto-detection). All targets are remembered for restore.
  - `name@tag` - pin to a specific tag (e.g. `pkglab add @clerk/pkg@feat1`)
  - `--tag`/`-t` - apply a tag to all packages at once (e.g. `pkglab add pkg --tag feat1`). Cannot combine with inline `@tag` syntax
  - `--scope`/`-s` - replace all packages of a given scope in the workspace (e.g. `--scope clerk` or `--scope @clerk`), scanning workspace root + sub-packages for matching deps and verifying all are published before modifying files. Cannot combine with positional package names or `-p`/`--packagejson`
  - `--catalog`/`-c` - strict catalog mode, errors if a package is not in any catalog
  - `--packagejson`/`-p` - target a single sub-package directory instead of workspace scanning (e.g. `-p apps/dashboard`). Cannot combine with `--scope`
  - `--dry-run` - preview what would be installed
  - `--verbose`/`-v` - show detailed workspace scanning output
- `pkglab restore <name...>` - restore pkglab packages to their original versions across all targets updated by `pkglab add` (catalog, sub-packages, or both). Accepts multiple names. Runs pm install to sync node_modules, cleans `.npmrc` if no packages remain.
  - `--all` - restore every pkglab package in the repo
  - `--scope <scope>` - restore all packages matching a scope (mirrors add `--scope`)
  - `--tag`/`-t` - restore only packages installed with a specific tag
- `pkglab check` - pre-commit safety check. Scans for pkglab artifacts in `package.json` and `.npmrc` (local versions, registry markers, staged files) across workspace root and sub-packages. Also scans staged lockfiles (`bun.lock`, `bun.lockb`, `pnpm-lock.yaml`) for localhost registry URLs. Returns exit code 1 if anything is found.

Repo management

- `pkglab repo ls` - list consumer repos with their active/inactive status and linked packages.
- `pkglab repo on/off [name...]` - activate or deactivate consumer repos. Accepts multiple paths. `--all` to activate or deactivate every repo. Interactive picker if no name given.
- `pkglab repo reset [name]` - clear all state for a repo, restoring original package versions and running pm install. `--all` to reset every repo. `--stale` to remove repos whose directories no longer exist.
- `pkglab pkg ls` - list published packages in the local registry, grouped by tag with the latest version per tag. Checks if the registry is running first.
- `pkglab pkg rm <name...>` - remove packages from the local registry entirely (API + storage). Accepts multiple names. `--all` removes every package and clears fingerprint state.

Maintenance

- `pkglab doctor` - diagnose your setup. Checks directory structure, daemon health, registry connectivity, and `.npmrc` content across all linked repos. Auto-repairs missing or broken `.npmrc` registry blocks. Detects dirty state (daemon not running but repos have active pkglab packages) and suggests recovery steps.
  - `--lockfile` - sanitize `bun.lock` files in consumer repos by replacing localhost registry URLs with `""` (tells bun to use the default registry)
  - `--prune` - remove stale fingerprint files for workspaces that no longer exist on disk
- `pkglab reset --hard` - wipe all pkglab data and registry storage. Stops the daemon if running.
- `pkglab reset --fingerprints` - clear the fingerprint cache. Next `pub` will republish all packages regardless of content changes.
- `pkglab hooks init` - scaffold `.pkglab/hooks/` in the current repo with type definitions (`payload.d.ts`) and commented-out stubs for all 7 hook events. Hooks let consumer repos run custom scripts at lifecycle moments (before/after add, restore, and publish-triggered updates). Each hook receives a typed JSON payload as its first argument. Supports `.ts` (run with bun), `.sh` (run with bash), and extensionless (direct execution) formats. Pre-hooks can abort operations, post-hooks are advisory. See [Repo hooks](#repo-hooks) for details.

`pkglab add` automatically injects `pkglab check` into your pre-commit hook (Husky, or raw `.git/hooks/pre-commit`). For Lefthook, add it manually:

```yaml
# lefthook.yml
pre-commit:
  commands:
    pkglab-check:
      run: npx pkglab check
```

## Multi-worktree support

When working on multiple branches simultaneously using git worktrees, you can publish from each worktree with a different tag to avoid version conflicts.

```bash
# From the main worktree
pkglab pub

# From a feature worktree
pkglab pub --tag feat-auth
# or auto-detect from branch name
pkglab pub --worktree

# Consumer repos pin to a specific tag
pkglab add @clerk/pkg@feat-auth
# or use --tag to apply a tag to all packages at once
pkglab add @clerk/pkg --tag feat-auth

# Replace all packages of a scope with their local versions
pkglab add --scope clerk --tag feat-auth

# Or use the interactive picker to browse packages and tags
pkglab add
```

Each tag gets its own version channel. Publishing untagged only auto-updates consumers that are also untagged, and publishing with `--tag feat-auth` only updates consumers pinned to `feat-auth`. Pruning also respects tags, keeping the N most recent versions per tag per package.

Branch names are sanitized for use as tags: `feat/auth-rewrite` becomes `feat-auth-rewrite`. Tags are capped at 50 characters.

## Catalog support

If your consumer repo uses the `catalog:` protocol (Bun or pnpm workspaces), pkglab auto-detects catalog entries and updates the catalog source directly, preserving `catalog:` references in individual package.json files.

```bash
# Auto-detects that these packages are in a catalog and updates the catalog source
pkglab add @clerk/backend @clerk/shared

# Use --catalog for strict mode (errors if a package is not in any catalog)
pkglab add --catalog @clerk/backend @clerk/shared

# Restore puts the original catalog versions back
pkglab restore --all
```

pkglab auto-detects which catalog format your workspace uses:

For bun/npm workspaces, catalogs live in the root package.json:

```json
{
  "catalog": {
    "@clerk/backend": "^3.0.0",
    "@clerk/shared": "^2.0.0"
  }
}
```

For pnpm workspaces, catalogs live in pnpm-workspace.yaml:

```yaml
catalog:
  '@clerk/backend': '^3.0.0'
  '@clerk/shared': '^2.0.0'
```

Named catalogs (`catalogs.react19`, etc.) are also supported in both formats. pkglab finds which catalog contains each package automatically.

When `pkglab pub` auto-updates consumer repos, catalog-linked packages are updated in the catalog (not in individual package.json files), preserving the `catalog:` references.

Bun caveat: bun caches registry metadata internally, so freshly published versions can be invisible to a plain `bun install`. pkglab works around this by temporarily setting `disableManifest = true` in `bunfig.toml` during consumer updates, then restoring it. This will become unnecessary once bun supports catalogs in `bun add` directly, at which point pkglab can use the non-catalog install path for bun.

## How versioning works

`pkglab` generates versions in the format `0.0.0-pkglab.{timestamp}` (untagged) or `0.0.0-pkglab-{tag}.{timestamp}` (tagged). The monotonic timestamp ensures versions always increment, even across rapid publishes. The `0.0.0-pkglab` prefix makes these versions instantly recognizable and ensures they sort below any real release.

When using tags, each tag gets its own version channel. Publishing with `--tag feat1` only updates consumers pinned to `feat1`, leaving other consumers untouched. This lets you work on multiple branches simultaneously from different git worktrees without version conflicts.

## Design decisions

**The duplicate-instance problem.** In a monorepo like Clerk's, `@clerk/nextjs` depends on both `@clerk/react` and `@clerk/backend`, which both depend on `@clerk/shared`. If you publish `@clerk/react` and cascade to `nextjs`, but `backend` isn't in the publish set, the consumer ends up with two versions of `@clerk/shared`: a new one (from the react cascade) and an old one (from the previous backend publish). Two versions of the same package means two module instances in Node.js, even if the code is identical. Singleton state isn't shared, `instanceof` checks fail across the boundary, and React contexts created by one version are invisible to the other.

**Close under deps.** The cascade now ensures every published package has all its workspace dependencies also in the publish set. If `nextjs` is being published and it depends on `backend`, `backend` gets pulled in. This eliminates floating `workspace:` references that could resolve to stale versions. Any workspace shorthand dep not covered by the cascade is treated as a bug and throws an error at publish time.

**Why not publish the full connected component?** The obvious fix is to publish every package connected through the dependency graph. But in a monorepo where a shared utility connects everything, publishing any one package would publish the entire repo. For Clerk, that's ~15 packages when you only changed one.

**Content-aware publishing.** Instead of giving every package a new version, pkglab fingerprints each package by globbing the publishable file set (the `files` field, always-included files like package.json/README/LICENSE/LICENCE/CHANGELOG, and entry points from main/module/types/bin/exports) and SHA-256 hashing their contents. Packages are classified in topological order: "changed" if the content hash differs from the previous publish, "propagated" if the content is the same but a dependency got a new version, or "unchanged" if nothing is different. Unchanged packages keep their existing version and are skipped entirely.

**Two-phase cascade.** The cascade doesn't compute all dependents upfront. Instead, it works in two phases: first fingerprint, then expand. This matters because expanding dependents from an unchanged package is pointless (it kept its old version, so nothing downstream needs updating). Consider this workspace:

```
pkgA (shared utility)
  ├── pkgB ── pkgD (target)
  └── pkgC
```

You run `pkglab pub` from pkgD. Phase one pulls in pkgD's transitive deps (pkgB, pkgA) and fingerprints them. What happens next depends on what actually changed:

Scenario 1: you edited pkgA.

```
pkgA (shared utility)    ← changed
  ├── pkgB ── pkgD       ← propagated, propagated
  └── pkgC               ← pulled in as dependent of pkgA
```

pkgA is classified as "changed," so phase two expands its dependents. pkgC gets pulled into scope because it depends on the package that changed. All four packages are published with new versions, so consumers see a consistent set.

Scenario 2: pkgA is unchanged.

```
pkgA (shared utility)    ← unchanged, skipped
  ├── pkgB ── pkgD       ← changed (you edited pkgB or pkgD)
  └── pkgC               ← not in scope, stays on old version
```

pkgA keeps its existing version and pkgC is never pulled in. The cascade stays narrow: only pkgB and pkgD get new versions. Consumers already have a working pkgA, so there's no inconsistency.

This two-phase approach gives you the best of both worlds. Narrow publishes when nothing upstream changed, automatic expansion when a shared dependency did change. The loop repeats until no new packages are added (a fixpoint), so deeply nested dependency changes propagate correctly through the entire graph.

**The cascade in three steps.**

1. DOWN (deps): pull in transitive deps of the target, unconditionally. These must be in scope so `workspace:^` references resolve.
2. UP (dependents): expand from packages whose content actually changed. If `shared` is unchanged, don't cascade to `express`/`remix`. If `shared` changed, pull them in.
3. PUBLISH filter: of the dependents pulled in by step 2, only publish the ones a consumer has installed (via `pkglab add`). `express` not consumed? Skip it.

When no consumer repos are active (you haven't run `pkglab add` anywhere), the consumed set is empty and the filter removes all dependents. The result is targets + deps only. Once you add a consumer repo, dependents of changed packages start flowing through.

`--shallow` skips step 2 entirely: targets + their transitive deps, no dependent expansion, regardless of whether consumer repos exist. Useful for a quick publish when you know you only care about the target.

Trade-off: adding a previously-skipped package via `pkglab add` gives the last-published version until the next `pkglab pub`.

**Fast consumer installs.** When auto-updating consumer repos, pkglab writes version updates to package.json (or catalog), then runs a single `pm install --ignore-scripts` per repo. If install fails, it retries with scripts enabled, and rolls back package.json changes if that also fails. For pnpm consumers, pkglab patches pnpm-lock.yaml directly (replacing version strings and integrity hashes) and runs `pnpm install --frozen-lockfile` to skip the expensive resolution phase entirely. Falls back to regular install if patching fails. Use `--no-pm-optimizations` to disable all install optimizations and run a plain `pm install` instead.

## Configuration

`pkglab` stores its state in `~/.pkglab/`. The config file at `~/.pkglab/config.json` supports:

- `port`: registry port (default: 16180)
- `prune_keep`: number of old versions to retain per package (default: 3)

Logs are written to `${tmpdir()}/pkglab-${uid}/registry.log` (platform-aware, e.g. `/tmp/pkglab-501/registry.log` on macOS).

Set `PKGLAB_NO_MTIME_CACHE=1` to disable the mtime-based fingerprint fast path and always do full content hashing.

## Repo hooks

Consumer repos can run custom scripts at lifecycle moments by placing files in `.pkglab/hooks/`. This is useful for setting environment variables, restarting dev servers, or running any repo-specific setup when local packages are installed or removed.

```bash
# Scaffold the hooks directory with type definitions and example stubs
pkglab hooks init
```

This creates `.pkglab/hooks/` with a `payload.d.ts` type definition and commented-out stubs for all 7 events:

- `pre-add` / `post-add` - before/after `pkglab add`
- `pre-restore` / `post-restore` - before/after `pkglab restore`
- `pre-update` / `post-update` - before/after `pkglab pub` auto-updates this repo
- `on-error` - when any operation fails (for cleanup)

Hooks can be `.ts` (run with bun), `.sh` (run with bash), or extensionless (direct execution). Each hook receives a typed JSON payload as its first argument with package details, registry URL, tag, and event info.

Pre-hooks can abort operations by exiting non-zero. For `add`/`restore`, this stops the command. For `pub` auto-updates, it skips that repo and continues with others. Post-hooks are advisory (failures are logged but don't affect the exit code). The `on-error` hook is best-effort and non-recursive.

Example: point Clerk SDKs to a local API when local packages are installed.

```typescript
// .pkglab/hooks/post-add.ts
import type { PkglabHookPayload } from './payload';
const payload: PkglabHookPayload = JSON.parse(process.argv[2]);

const envFile = Bun.file('.env.local');
const existing = await envFile.exists() ? await envFile.text() : '';
const cleaned = existing.split('\n').filter(l => !l.startsWith('CLERK_API_URL=')).join('\n');
await Bun.write(envFile, cleaned.trimEnd() + '\nCLERK_API_URL=http://localhost:3100\n');
```

Hooks persist across add/restore cycles and can be committed to version control. The default timeout is 30 seconds per hook, overridable via `PKGLAB_HOOK_TIMEOUT_MS`.

## Performance

pkglab ships its own registry server built on `Bun.serve()`. Package metadata is held in memory with write-through persistence to disk, so reads are served directly from memory without touching the filesystem or making HTTP round-trips.

Benchmarks from the [Clerk JavaScript SDK](https://github.com/clerk/javascript) monorepo (22 packages, Apple M4 Pro, Bun 1.3.9):

- Cold start: 59ms (daemon process to first request)
- Publish (22 packages): 1.06s (cascade, fingerprinting, parallel publish)
- Packument GET: 0.09ms (in-memory index lookup)
- Memory idle (RSS): 44MB
- Memory after publish: 45MB

Memory stays flat because the server only loads package metadata (packument JSON docs) into memory, not tarballs. Tarballs are served directly from disk via `Bun.file()`. For a typical local development workflow with tens of packages, the memory footprint stays well under 50MB.

You can run the benchmark yourself:

```bash
bun run benchmarks/registry-benchmark.ts
```

## Safety

`pkglab` is designed to prevent local development artifacts from leaking into your codebase:

- `.npmrc` modifications are guarded by the `pkglab check` pre-commit hook, which catches localhost registry URLs before they can be committed
- Automatic pre-commit hook injection: on first `pkglab add`, a `pkglab check` call is injected into the consumer's pre-commit hook (Husky or raw git hooks). Removed automatically on restore when no packages remain. Lefthook requires manual setup (see [Commands](#commands))
- Lockfile sanitization: after every pkglab-managed install, `bun.lock` is post-processed to replace localhost registry URLs with `""` (bun resolves from the default registry). This prevents CI hangs if the lockfile gets committed while pkglab is active
- `pkglab check` scans for any remaining artifacts (package versions, `.npmrc` markers, staged files, lockfile localhost URLs) and returns a non-zero exit code
- `pkglab restore` restores original package versions and cleans up `.npmrc` and pre-commit hooks
- `pkglab down` restores all consumer repos before stopping the daemon, preventing broken state
- `pkglab doctor` verifies and repairs `.npmrc` content, detects dirty state, and can sanitize lockfiles with `--lockfile`

## Acknowledgments

- [Verdaccio](https://github.com/verdaccio/verdaccio) is the project that made local npm registries practical. pkglab started as a wrapper around Verdaccio, and the team's work on registry compatibility and plugin architecture made it possible to prototype quickly before building a custom server.
- [yalc](https://github.com/wclr/yalc) pioneered the copy-based approach to local package development and showed that symlinks aren't the only way. pkglab takes the idea further by using a real registry, but yalc remains a great lighter-weight option if you don't need registry-level validation. Thank you to the yalc maintainers for paving the way.

## License

MIT
