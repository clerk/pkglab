---
"pkglab": patch
---

Fix correctness, crash safety, and race condition bugs across commands and core libraries

- Fix re-add overwriting original version in repo state (add.ts)
- Scan peerDependencies and optionalDependencies during version updates (consumer.ts)
- Fix npmrc marker removal when markers are out of order (consumer.ts)
- Use atomic writes for npmrc modifications (consumer.ts)
- Add workspace root fallback for restore command (restore.ts)
- Load pnpm default catalog (singular `catalog:`) in workspace discovery (workspace.ts)
- Use process.execPath with bunEnv for npm pack fallback in fingerprinting (fingerprint.ts)
- Scan pnpm-workspace.yaml catalogs in pre-commit check (check.ts)
- Use per-workspace lock paths for listener startup (listener-daemon.ts, listener-ipc.ts)
- Drain stderr in listener spawn to prevent pipe buffer deadlock (listener-daemon.ts)
- Record daemon startedAt before spawn to avoid PID validation race (daemon.ts)
- Clean up socket buffers on listener connection error (listener-core.ts)
- Remove unreliable Linux /proc PID validation fallback (proc.ts)
- Save repo state after each package restore in down command for crash safety (down.ts)
- Acquire publish lock during down restore to prevent races (down.ts)
- Stop all listeners globally during down instead of per-workspace (down.ts)
- Track successful publishes separately for partial failure dist-tag handling (pub.ts)
- Guard against missing repo state entry during consumer updates (pub.ts)
- Add bounded concurrency for parallel publishing (publisher.ts)
- Replace O(n) queue.shift with O(1) index-based dequeue in toposort (graph.ts)
