---
"pkglab": patch
---

Simplify repo loading: extract RepoEntry type, deduplicate stale lock check, parallelize existence checks, eliminate redundant disk reads in up command.
