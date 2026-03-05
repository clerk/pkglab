---
"pkglab": patch
---

Add timeout option to run() subprocess helper. If a spawned process hangs beyond the deadline, it gets killed and an error is thrown. Applied a 5s timeout to validatePidStartTime to prevent indefinite hangs during daemon status checks.
