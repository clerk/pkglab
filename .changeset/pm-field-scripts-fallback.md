---
'pkglab': minor
---

Breaking: detect the consumer package manager from the `package.json` `packageManager` field before lockfiles (nearest folder wins).

Breaking: failed `install --ignore-scripts` runs are no longer retried with scripts enabled; the install fails and rolls back. Use `--no-pm-optimizations` for a plain install. Yarn 2+ consumers get `--mode=skip-build`, since they reject `--ignore-scripts`.

Breaking (security): the registry now requires a per-machine token (`~/.pkglab/token`) on every write and rejects foreign `Host` headers. Restart the registry after upgrading (`pkglab down && pkglab up`).

Breaking (security): only `0.0.0-pkglab*` versions can be published, `latest` can't be set, tarball names and integrity are checked, and `/-rev/` updates can only remove versions. `pub --ping` requests validate targets, tag and workspace path.

Breaking (security): repo hooks only run after `pkglab hooks trust` (new command), and any edit in `.pkglab/hooks/` needs re-trust. `hooks init` trusts its stubs. `pkglab pub --tag latest` is rejected.

Security: the pre-commit hook runs `pkglab check` only when `pkglab` is on `PATH` instead of `npx pkglab check`, and `pkglab check` flags a staged `.husky/pre-commit` containing the pkglab block. Logs moved to `~/.pkglab/logs/`. pkglab refuses to write through symlinked `.npmrc`, `bunfig.toml` and pre-commit hook files.
