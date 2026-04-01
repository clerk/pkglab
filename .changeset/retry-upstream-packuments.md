---
"pkglab": patch
---

Buffer and validate upstream packument responses before serving to npm clients, with retry on corrupted JSON. Fixes transient CI failures with large packuments.
