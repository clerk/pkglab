---
"pkglab": patch
---

Add atomicWrite helper (temp file + rename) and use it for repo state, .npmrc, fingerprints, and lockfile patching to prevent corrupt partial writes from concurrent processes
