Verbunccio, the built-in Bun.serve() registry, has replaced Verdaccio. This handoff is historical.

Read these files for full context:

- docs/plans/2026-02-15-verbunccio-design.md (full design, Codex-reviewed, all decisions finalized)
- CLAUDE.md (project conventions, commands, structure)

Done:

- Research phase: 3 sonnet agents surveyed all registry alternatives, confirmed no viable replacement exists
- Design phase: opus agent + Codex 5.3 MCP produced the design doc
- Codex review: identified critical issues (upstream proxy needed, don't strip non-pkglab versions, audit stubs, server-owned cleanup), all incorporated into design doc
- Design doc updated with: upstream proxy section, compatibility stubs, full packuments only in v1, monorepo benchmark plan, memory tracking

Continue from: Implementation (parallel opus agents)

Split into 3 parallel opus agents:

1. Storage + Worker agent (new files):
   - `src/lib/verbunccio-storage.ts`: in-memory index, write-through persistence, per-package mutex, atomic writes
   - `src/lib/verbunccio-worker.ts`: Bun.serve() entry point, request routing, upstream proxy, ready signal

2. Routes agent (new file):
   - `src/lib/verbunccio-routes.ts`: all HTTP handlers (publish, packument, tarball, delete, update, dist-tags, index, stubs)
   - `proxyToUpstream()`: transparent proxy for unknown packages

3. Integration agent (modified files):
   - `src/index.ts`: add `--__worker` env var check for verbunccio-worker
   - `src/lib/paths.ts`: add `registryStorage` alias
   - `src/lib/registry.ts`: switch to HTTP index reads, remove client-side rm -rf, add 409 retry, check resp.ok on setDistTag
   - `src/lib/daemon.ts`: backend field in PID file, update validatePid, generic error messages
   - `src/lib/prune.ts`: use HTTP index when available

After implementation:

- Run `bun run test:e2e` to verify all 131 tests pass
- Codex review via /lcodex
- Write benchmark script (`benchmarks/registry-benchmark.ts`)
- Update README.md with Verbunccio/PKGLAB_VERBUNCCIO docs

Verify with:
bun run test:e2e

Env var: PKGLAB_VERBUNCCIO=1 enables the new backend

Invoke these skills first: /lsuperpowers

Workflow: parallel opus agents for implementation, I review each agent's output, /lcodex for final review. User prefers direct execution over plan mode. Never enter plan mode unprompted. Always update README.md for public-facing changes. Never use em dashes.
