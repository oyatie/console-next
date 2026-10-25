Reason: Declared in apps/web dependencies since the initial commit; no tracked source imports it today, so this bump only moves the declared and locked version (removal is a separate decision).
Provenance: Version 4.6.7 is pinned in package-lock.json from https://registry.npmjs.org/zod/-/zod-4.6.7.tgz with an integrity hash, matching the registry URL recorded in dependency-verification.json.
License: MIT, as recorded in package-lock.json and by `npm view zod@4.6.7 license`.
Security: Fixes GHSA-mrhx-c7xc-m3w5 (high; memory exhaustion validating oversized constrained collections; vulnerable < 4.6.6, first patched 4.6.6); 4.6.7 is above the first patched version.
