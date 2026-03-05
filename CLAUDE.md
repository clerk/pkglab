# pkglab

Local package development CLI with a built-in registry. Publish workspace packages locally and auto-update consumer repos.

Runtime: Bun
CLI framework: citty
Colors: `Bun.color()` via `src/lib/color.ts` (no picocolors)

IMPORTANT: pkglab is distributed as a standalone binary via BanBinary. In compiled mode, `process.execPath` points to the pkglab binary itself. There are two categories of subprocess spawning:

1. Spawning pkglab's own commands (`pub`, `--__worker`, `--__prune`, `--__listener`): use `process.execPath` with normal env. The compiled binary runs pkglab's CLI.
2. Spawning bun runtime commands (`publish`, `run`, `install`): use `process.execPath` with `BUN_BE_BUN=1` env var (via `bunEnv()` from `src/lib/proc.ts`). This makes the compiled binary ignore its bundled entrypoint and act as the plain bun CLI.

ALWAYS use `process.execPath` for subprocesses, NEVER hardcode `'bun'`. The compiled binary ships the full Bun runtime. Use `bunEnv()` when you need bun CLI behavior instead of pkglab CLI behavior.

## CLI commands

Top-level:

- `pkglab up` — start the local registry (pub and add auto-start if down)
- `pkglab down` — stop the registry. By default, restores all consumer repos first (versions, `.npmrc`, pre-commit hooks), then stops the daemon. If any restore fails, daemon stays up. `--force`/`-f` skips restoration and stops immediately.
- `pkglab status` — show registry status. `--health` exits 0 if healthy, 1 if not (silent, for scripting)
- `pkglab logs` — show registry logs
- `pkglab pub [name...]` - publish workspace packages to local registry, auto-updates active consumer repos. Accepts multiple names. Fingerprints packages and skips unchanged ones. Uses mtime+size gating to skip content hashing for unchanged files (disable with `PKGLAB_NO_MTIME_CACHE=1`). Flags: `--single` skip cascade/fingerprinting, `--shallow` targets + deps only (no dependent expansion), `--force`/`-f` ignore fingerprints (republish all), `--tag`/`-t` publish with tag, `--worktree`/`-w` auto-detect tag from branch, `--root` publish all packages regardless of cwd (same as running from workspace root, errors if combined with positional names), `--ping` send publish request to the registry server via HTTP instead of publishing directly, `--no-pm-optimizations` skip lockfile patching and install optimizations (plain `pm install`), `--dry-run`, `--verbose`/`-v` (includes per-phase timing: fingerprint, cascade, publish, consumer)
- `pkglab listen` - (deprecated) shows a deprecation notice and displays publish queue status from the registry. Publish coalescing is now built into the registry server. The old Unix socket listener is no longer used.
- `pkglab add [name[@tag]...]` — add pkglab packages to the current repo. Accepts multiple names. No args for interactive picker. Batch installs in one command. On first add to a repo, injects `pkglab check` into the pre-commit hook (Husky or raw git, warns for Lefthook manual setup). Auto-detects when a package exists in a workspace catalog and uses catalog mode automatically. `--catalog`/`-c` enables strict mode (errors if the package is not in any catalog). Supports both bun/npm catalogs (package.json) and pnpm catalogs (pnpm-workspace.yaml). In a workspace, auto-scans all sub-packages for the dependency and updates all of them (sub-packages using `catalog:` protocol are skipped, handled by catalog auto-detection). `--packagejson`/`-p` opts out of workspace scanning and targets a single sub-package directory (e.g. `-p apps/dashboard` from monorepo root). `--tag`/`-t` applies a tag to all packages (`pkglab add pkg --tag feat1` is equivalent to `pkglab add pkg@feat1`), errors if combined with inline `@tag` syntax. `--scope`/`-s` replaces all packages of a given scope in the workspace (e.g. `--scope clerk` or `--scope @clerk`), normalizes to `@clerk/`, scans workspace root + sub-packages for matching deps, verifies all are published before modifying files. Cannot combine `--scope` with positional package names. `--dry-run` previews what would be installed without making changes. `--verbose`/`-v` shows detailed output about workspace scanning and decisions. Targets are remembered for restore.
- `pkglab restore <name...>` — restore pkglab packages to their original versions across all targets that were updated by `pkglab add`, runs pm install to sync node_modules. Accepts multiple names. `--all` restores all packages in the repo. `--scope <scope>` restores all packages matching a scope (mirrors add `--scope`). `--tag`/`-t` restores only packages installed with a specific tag. Removes pre-commit hook injection when no packages remain.
- `pkglab doctor` — diagnose issues. Detects dirty state (daemon not running but repos have active packages). `--lockfile` sanitizes `bun.lock` files by replacing localhost URLs with `""`.
- `pkglab check` — check for pkglab artifacts in workspace root and sub-packages. Scans staged lockfiles (`bun.lock`, `bun.lockb`, `pnpm-lock.yaml`) for localhost registry URLs.
- `pkglab reset --hard` — wipe all pkglab data and registry storage
- `pkglab reset --fingerprints` — clear fingerprint cache, forces full republish on next pub

- `pkglab hooks init` — scaffold `.pkglab/hooks/` in the current repo with `payload.d.ts` (typed `PkglabHookPayload` interface) and commented-out stubs for all 7 hook events. Hooks are executable files that run at lifecycle moments: `pre-add`, `post-add`, `pre-restore`, `post-restore`, `pre-update`, `post-update`, `on-error`. Supports `.ts` (bun), `.sh` (bash), and extensionless (direct) formats. Each hook receives a JSON payload as argv[1]. Pre-hooks can abort operations (non-zero exit), post-hooks are advisory, on-error is best-effort. Hook runner module lives at `src/lib/hooks.ts`.

Subcommands:

- `pkglab repo ls` — list consumer repos
- `pkglab repo on [name...]` — activate repos (accepts multiple paths). `--all` to activate every repo
- `pkglab repo off [name...]` — deactivate repos (accepts multiple paths). `--all` to deactivate every repo
- `pkglab repo reset [name]` — reset repo state, restores original versions and runs pm install. `--all` to reset every repo, `--stale` to remove repos whose directories no longer exist
- `pkglab pkg ls` — list published packages (checks if registry is running)
- `pkglab pkg rm <name...>` — remove packages from registry (also `--all`)

## Workflow

1. `pkglab up` — start the local registry
2. `pkglab pub` — publish workspace packages (from the library repo)
3. `pkglab add <pkg>` — install a pkglab package in a consumer repo (run from consumer repo dir)
4. Iterate: make changes to the library, run `pkglab pub` again — active consumer repos are auto-updated
5. `pkglab restore <pkg...>` or `pkglab restore --all` — restore original versions when done
6. `pkglab down` — stop the registry

For multi-worktree workflows, use tags to isolate version channels:

- `pkglab pub -t feat1` or `pkglab pub -w` (auto-detect from branch)
- `pkglab add pkg@feat1` (consumer pins to that tag)
- Each tag's publishes only update consumers pinned to the same tag

## Project layout

- `src/index.ts` — entry point, registers all commands via lazy imports
- `src/commands/` — one file per command, each exports `defineCommand()` as default
- `src/commands/repos/`, `src/commands/pkg/` — subcommand groups with their own index.ts
- `src/lib/` - shared utilities (config, daemon, publisher, registry, fingerprint, publish-queue, publish-ping, etc.)
- `src/types.ts` — all shared interfaces

Config and state live in `~/.pkglab/`. Registry storage at `~/.pkglab/registry/storage/`. Fingerprint state at `~/.pkglab/fingerprints/` (per-workspace files).

## Conventions

- Bun APIs over Node when available (Bun.file, Bun.write, Bun.spawn)
- Strict tsconfig with noUnusedLocals and noUnusedParameters
- No test framework set up
- No linter/formatter config — tsconfig strict mode is the guardrail
- Custom errors extend `pkglabError` in `src/lib/errors.ts`
- Logging through `src/lib/log.ts` (info, success, warn, error, dim, line)
- Class/function naming uses lowercase "pkglab" (pkglabConfig, pkglabError, ispkglabVersion)

## Adding commands

1. Create `src/commands/<name>.ts` exporting `defineCommand()` as default
2. Register in `src/index.ts` subCommands with a lazy import
3. Use `args` for CLI flags, `run({ args })` for the handler

## Cascade and fingerprinting

`pkglab pub` uses a two-phase cascade to determine the publish scope. Private packages are excluded from the closure.

Phase 1 (initial scope): targets + their transitive workspace deps, closed under deps (every publishable package has its workspace deps in the set).

Fingerprinting: each package in scope is fingerprinted using `Bun.Glob` + `Bun.CryptoHasher` (SHA-256) to hash the publishable file set (the `files` field, always-included files, and entry points from main/module/types/bin/exports). Falls back to `npm pack --dry-run --json` for packages with bundledDependencies. On repeat runs, mtime+size metadata is checked first: if all files match the previous run's stats, the cached hash is reused without reading file contents. File stats are persisted alongside hashes in `~/.pkglab/fingerprints.json`. Set `PKGLAB_NO_MTIME_CACHE=1` to disable the fast path and always content-hash. Packages are classified in topological order:

- "changed": content hash differs from previous publish
- "propagated": content same, but a workspace dep was changed/propagated
- "unchanged": content same, no deps changed (skipped, keeps existing version)

Phase 2 (dependent expansion): for each package classified as "changed," expand its transitive dependents into the scope. Expanding from "propagated" is skipped because every dependent of a propagated package is already a transitive dependent of the original changed package. New packages are fingerprinted and classified, and the loop repeats until no new changed packages are found. This ensures that if a dependency (like `@clerk/shared`) changes, all its dependents (like `@clerk/express`) are included even if they weren't in the original targets.

Fingerprint state is stored per workspace in separate files under `~/.pkglab/fingerprints/`, keyed by a SHA-256 hash of the workspace root path (e.g. `~/.pkglab/fingerprints/a1b2c3d4e5f6.json`). Each file contains per-package, per-tag entries. This eliminates cross-workspace race conditions when multiple workspaces publish concurrently. On first load, data is auto-migrated from the old monolithic `~/.pkglab/fingerprints.json` if present. Treated as a cache: missing/corrupt state triggers a full republish. State is saved after consumer updates succeed.

The cascade has three steps: (1) DOWN: pull in transitive deps of targets so `workspace:^` references resolve, (2) UP: expand dependents from packages whose content actually changed, (3) PUBLISH filter: only publish dependents that a consumer has installed via `pkglab add`. No active repos means nothing is consumed, so the filter removes all dependents.

`--single` bypasses cascade and fingerprinting entirely.
`--shallow` runs step 1 (DOWN) only, skipping dependent expansion and the consumer filter. Targets + their transitive deps, nothing more.
`--force`/`-f` ignores previous fingerprint state (republishes all packages) but still computes and saves new fingerprints.

## Pub command output

Default output shows a color-coded scope summary (package list with scope/change reasons), then spinners for publishing. Scope reasons show "target", "dependency", or "dependent (via X)" with change status. `--verbose`/`-v` adds the initial scope, expansion steps, and private-package warnings.
Pruning runs in a detached subprocess (`src/lib/prune-worker.ts`) to avoid blocking exit.

## Version format

Untagged: `0.0.0-pkglab.{timestamp}`
Tagged: `0.0.0-pkglab-{tag}.{timestamp}`

Old format (`0.0.0-pkglab.{YY-MM-DD}--{HH-MM-SS}.{timestamp}`) treated as untagged for backwards compat.

extractTimestamp reads after the last dot, extractTag reads between `pkglab-` and the last dot.

## Testing

IMPORTANT: After making changes to commands or core lib code, always run `bun run test:e2e` and verify all tests pass before committing.

IMPORTANT: After changing commands, flags, or CLI behavior, always update README.md and CLAUDE.md. This is not optional. README.md is the public-facing documentation and must reflect the current CLI surface.

## /cmt Skill Config

Scopes: pub, pkgs, repos, daemon, consumer, registry, version, config, hooks, perf

IMPORTANT: Changesets are MANDATORY for every commit made with /cmt. Always create a changeset file in `.changeset/` with the appropriate bump level (patch for fixes, minor for features) and stage it together with the code changes. Never commit without a changeset.
