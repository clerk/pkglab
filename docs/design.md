# pkglab design document

A CLI tool for local package development using Verdaccio as a real npm registry. Replaces yalc with a more reliable approach that matches real npm publish/install behavior.

## Problem

Testing local packages during development is painful. Existing solutions have fundamental issues:

- `npm link` / `yarn link`: symlinks cause peer dependency resolution failures, duplicate React instances, and bundler confusion
- `yalc`: copies files directly into node_modules, bypassing the package manager entirely. This means lockfiles are stale, peer deps are unresolved, and the install doesn't match what users will actually get from npm

The core issue: all existing tools diverge from the real npm install path. This creates subtle bugs that only surface when the package is actually published.

## Solution

pkglab runs a local Verdaccio registry and publishes packages to it with synthetic versions. Consumer repos install from it using their native package manager (npm, pnpm, bun). The install path is identical to installing from the real npm registry.

No config files in repos. No build orchestration. No magic.

## Architecture

```
Publisher repo (e.g. Clerk monorepo)
    |
    | pkglab pub @clerk/backend
    v
~/.pkglab/verdaccio/  <-- local Verdaccio instance (127.0.0.1:4873)
    |                    proxies unknown packages to npm
    | pkglab add @clerk/backend
    v
Consumer repo (e.g. test app)
    .npmrc: registry=http://localhost:4873
    package.json: "@clerk/backend": "0.0.0-pkglab.1707500000000"
```

Two roles:

- Publisher repos: run `pkglab pub` to publish packages to Verdaccio
- Consumer repos: run `pkglab add` to install packages from Verdaccio

Connected through a local Verdaccio instance that pkglab manages. Verdaccio proxies anything not published locally to the real npm registry, so non-pkglab packages resolve normally.

## Version strategy

Packages are published as `0.0.0-pkglab.{timestamp_ms}` (e.g. `0.0.0-pkglab.1707500000000`).

- Timestamp uses `max(last_published_ts + 1, Date.now())` to guarantee monotonic ordering even under clock skew
- Each publish is a distinct version in the registry, triggering fresh installs
- Cache-busting: downstream compilers (Next.js, webpack) see a new version and invalidate caches
- The `0.0.0-pkglab.*` pattern is self-documenting in package.json — obvious when a package is from pkglab

Workspace dependencies are pinned to exact pkglab versions in the published package.json. All `workspace:` protocol references (`workspace:^`, `workspace:*`, `workspace:~`) are rewritten to the exact version being published. No `workspace:` specs survive into Verdaccio.

Peer dependencies: workspace peers are pinned to exact pkglab versions. External peers (non-workspace packages) are left as ranges.

## Cascade publish algorithm

When a package is published, pkglab publishes the entire affected dependency chain to ensure consistency.

Algorithm:

1. A package changes (manual `pkglab pub` or triggered by dev workflow)
2. Walk UP the dependency graph: find all workspace packages that transitively depend on the changed package
3. Compute the closure: the changed package + all its transitive dependents
4. For each package in the closure, include its forward workspace dependencies
5. Deduplicate, topologically sort (with deterministic lexical tie-breaking), assign a single timestamp
6. Publish all packages in order
7. On failure mid-chain: rollback by unpublishing all packages from this timestamp. No partial states.

Cycle handling: detect strongly connected components before toposort. If cycles exist, error with the cycle path. Do not attempt to publish cyclic dependency chains.

Example with Clerk's graph (`shared -> backend -> nextjs`, `shared -> react`):

```
Change in shared:
  reverse deps: backend, nextjs, react
  closure + forward deps: shared, backend, react, nextjs
  publish all with timestamp 1707500000000

Change in backend:
  reverse deps: nextjs
  closure + forward deps: shared, backend, nextjs
  publish all with timestamp 1707500000001

Change in nextjs:
  no reverse deps
  closure + forward deps: shared, backend, nextjs
  publish all with timestamp 1707500000002
```

Packages whose code didn't change still get re-published with updated manifests. Their dist files are identical — only the package.json dependency versions change to point to the new timestamp.

Uses `@manypkg/get-packages` for workspace discovery and `dependency-graph` for graph operations. Both are lightweight, stable, and support all major workspace formats (npm, pnpm, bun).

## Consumer registry config

`pkglab add` sets a global registry override in the consumer's `.npmrc`:

```
# pkglab-start
registry=http://localhost:4873
# pkglab-end
```

This redirects all package resolution through Verdaccio. Packages published to pkglab resolve to their `0.0.0-pkglab.*` versions. Everything else is proxied to npm transparently.

Conflict handling: if `.npmrc` already has a `registry=` line (e.g. pointing to a corporate proxy), pkglab errors with a clear message. A future release will add a compatibility mode flag for these setups.

Git safety: pkglab injects a `pkglab check` command into the repo's pre-commit hook (Husky, raw git, or warns for Lefthook). This scans staged lockfiles for localhost registry URLs and the workspace for pkglab version strings, preventing accidental commits. The `.npmrc` changes are visible in `git status` so developers stay aware of the local override.

On first `pkglab add` in a repo, pkglab prints a notice:

```
notice: pkglab added registry entries to .npmrc
These entries point to localhost and will break CI if committed.
A pre-commit hook (pkglab check) has been injected to catch this.
Run pkglab restore --all to restore your .npmrc.
```

## Scoped installs

When a publish triggers consumer updates, pkglab updates the version in the consumer's `package.json` and runs the PM's native single-package install for each changed package rather than a full `npm install`. For example:

```
npm install @clerk/backend@0.0.0-pkglab.1707500000000
```

pkglab only updates packages that the consumer already has in its `package.json` dependencies. It never adds new dependencies — only updates existing ones that were previously added via `pkglab add`.

pkglab detects the package manager by checking for lockfile presence (pnpm-lock.yaml, bun.lock, package-lock.json). If multiple lockfiles exist, pkglab errors and asks the developer to specify.

## Repo management

Consumer repos are tracked in per-repo files under `~/.pkglab/repos/` when they first run `pkglab add`.

Repo identity: filesystem path (canonicalized via `realpath`) is the internal key. The root package.json name is the display alias. On name collision, auto-suffix with `~2`, `~3`. `pkglab repos rename` allows custom aliases.

Per-repo state file:

```yaml
# ~/.pkglab/repos/my-app.yaml
path: /Users/nikos/Projects/my-app
active: false
packages:
  '@clerk/backend':
    original: '^4.1.0'
    current: '0.0.0-pkglab.1707500000000'
  '@clerk/shared':
    original: '^4.0.0'
    current: '0.0.0-pkglab.1707500000000'
```

The `original` field stores the pre-pkglab version for each package. `pkglab rm @clerk/backend` reads this value and restores it in `package.json`.

On `pkglab up`, all linked repos reset to inactive. Developer activates specific repos for the session:

```
$ pkglab up
pkglab running on http://localhost:4873

Linked repos (all inactive):
  my-app         /Users/nikos/Projects/my-app
  test-suite     /Users/nikos/Projects/test-suite
  demo-store     /Users/nikos/Projects/demo-store

Activate repos: pkglab repos activate <name>
```

After every `pkglab pub`, pkglab prints which active repos received updates:

```
Published 3 packages (ts: 1707500000000):
  @clerk/shared@0.0.0-pkglab.1707500000000
  @clerk/backend@0.0.0-pkglab.1707500000000
  @clerk/nextjs@0.0.0-pkglab.1707500000000

Updated active repos:
  my-app       npm install @clerk/backend@0.0.0-pkglab.1707500000000 ... done
  test-suite   npm install @clerk/backend@0.0.0-pkglab.1707500000000 ... done
```

## Daemon management

`pkglab up` spawns Verdaccio as a detached background process:

- Binds to `127.0.0.1` only (security: not accessible from network)
- PID written to `~/.pkglab/pid`
- Before using PID, validate the process is actually a pkglab-managed Verdaccio (not a stale PID reused by another process)
- Logs written to `/tmp/pkglab/verdaccio.log`
- Verdaccio config and storage under `~/.pkglab/verdaccio/`

`pkglab down` reads the PID, validates identity, and kills the process. `pkglab logs` tails the log file. `pkglab logs -f` for live streaming.

Port defaults to 4873, configurable in `~/.pkglab/config.yaml`. If the port changes, `pkglab up` updates the `.npmrc` in all linked repos.

Crash recovery: `pkglab up` checks for stale PID files on startup. If the PID file exists but the process is dead, pkgpkglabeans up and starts fresh. `pkgpkglabctor` detects and repairs orphaned state.

## Pruning

Every `pkglab pub` automatically prunes old versions per package, keeping the latest 3 (configurable in `~/.pkglab/config.yaml`). Before pruning, pkglab checks active consumer repos to ensure no referenced version is removed. Uses Verdaccio's API to unpublish old versions.

`pkglab prune` runs pruning manually. Since all versions follow the `0.0.0-pkglab.{timestamp}` pattern, sorting and pruning is trivial.

## Concurrency

A global publish mutex at `~/.pkglab/publish.lock` prevents concurrent `pkglab pub` invocations from producing inconsistent states (mixed timestamps, partial publishes). A per-consumer install mutex prevents thrashing when multiple publishes trigger consumer updates.

## Global config

```yaml
# ~/.pkglab/config.yaml
port: 4873
prune_keep: 3
```

Per-repo state files under `~/.pkglab/repos/`:

```yaml
# ~/.pkglab/repos/my-app.yaml
path: /Users/nikos/Projects/my-app
active: false
packages:
  '@clerk/backend':
    original: '^4.1.0'
    current: '0.0.0-pkglab.1707500000000'
```

No config files in publisher or consumer repos. All repo-level state lives in `.npmrc` (registry markers) and `package.json` (version strings) — files that already exist.

## CLI commands

```
pkglab up                        start Verdaccio daemon
pkglab down                      stop Verdaccio
pkglab status                    server info, active repos, published packages

pkglab pub [@scope/name]         publish package + cascade chain
                               no arg from workspace root: publish all
                               no arg from package dir: publish that package + cascade
pkglab pub --fast                publish current dist, skip dep checks
pkglab pub --dry-run             show what would be published

pkglab add @scope/name           add package to consumer repo
pkglab rm @scope/name            remove package, restore original version

pkglab repos ls                  list linked repos
pkglab repos activate <name>     activate repo for auto-updates
pkglab repos deactivate <name>   deactivate repo
pkglab repos reset <name>        reset specific repo
pkglab repos reset --all         reset all repos

pkglab pkgs ls                   list packages in Verdaccio
pkglab prune                     clean old versions
pkglab doctor                    health check (env, registry, daemon, git state)
pkglab logs [-f]                 tail Verdaccio logs
pkglab check                     pre-commit safety check for pkglab artifacts
```

## Package manager support

- npm: supported
- pnpm: supported
- bun: supported (reads .npmrc since v1.1.18)
- yarn berry: not supported

## Tech stack

- Runtime: Bun
- Registry: Verdaccio (embedded, managed by pkglab)
- Workspace discovery: @manypkg/get-packages
- Dependency graph: dependency-graph
- Config: YAML (~/.pkglab/)

## Open questions

- What happens when a consumer runs `npm install` while pkglab is stopped? Verdaccio is down, registry points to localhost, install fails. `pkglab doctor` should detect this state and offer to temporarily restore the original registry. No implicit fallback — explicit is better.
- Storage location for Verdaccio data: `~/.pkglab/verdaccio/` means package tarballs accumulate. Pruning handles versions, but consider adding `max_storage_mb` config for hard limits.
