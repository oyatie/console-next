<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Supersede Dependabot #313 with @types/node 26.6.6 to match the Node 26 runtime selected by .node-version and CI. The owner's 2026-10-26 permission covers existing package version bumps. Refresh the existing build/tooling requirement and pins with `node scripts/quality/generate-tooling-ledger.mjs --pins=npm:@types/node --write`; retain its approval, users and layer.

Provenance: Checked https://registry.npmjs.org/%40types%2Fnode/26.6.6 and https://registry.npmjs.org/undici-types/8.9.0 on 2026-11-02. Versions, tarball URLs, SHA-512 integrity and licenses match Dependabot's generated package-lock.json. @types/node identifies DefinitelyTyped/DefinitelyTyped, directory types/node, as its repository; undici-types identifies nodejs/undici. Only undici-types advertises a SLSA provenance attestation; it was not independently verified.

License: Both packages retain MIT, matching the prior locked versions.

Security: Both packages supply declarations for type checking. The lockfile adds no package names or locations; the existing transitive undici-types moves from 7.24.6 to 8.9.0 as required by @types/node. Neither published package declares an install lifecycle hook. Runtime dependencies, authentication and authorization behavior are unchanged.

`npm audit` on 2026-11-02 reports the same 11 moderate findings on the clean base and this bump, through minimatch in existing spreadsheet, schema-generation and mutation-testing chains. Neither declaration package is affected. No advisory ignore or override is added.

Before the repair, the exact CI command `npm run check` on base 7d0bc317f plus #313 refuses the unrecorded @types/node requirement, matching the PR's web job. The unchanged dependency gate passes on the clean base. Its existing refusal tests cover unrecorded requirements and missing version-specific evidence; no gate or baseline is relaxed for this bump.
