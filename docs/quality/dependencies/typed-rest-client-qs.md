<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Stryker selects typed-rest-client 2.3.1, which pins qs exactly to 6.15.1. Dependabot cannot resolve a patched child through that parent constraint. The root override applies only below typed-rest-client; other qs consumers keep their own requirements.

Provenance: qs 6.16.0 is verified against [npm metadata](https://registry.npmjs.org/qs/6.16.0); package-lock.json records its registry tarball and SHA-512 integrity. The requirement and resolved pin are recorded in scripts/quality/dependency-verification.json.

License: BSD-3-Clause, as recorded in npm metadata and the lockfile.

Security: The brief's proposed 6.15.2 fixes [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26), but remains affected by [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) and [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g). Both newer advisories first patch in 6.16.0, so that is the minimum audit-clean choice. No advisory is dismissed for this package.

Removal condition: Remove when the typed-rest-client release selected by Stryker declares a qs range admitting a patched release. Regenerate the lockfile without the override; the audit and compatibility tests must still pass.

Verification: scripts/dependency-overrides.test.ts checks the scoped requirement against this ledger and both the lockfile and installed parent resolution. It exercises typed-rest-client's CommonJS query encoding and reproduces all three qs defects. Run `npm test -- scripts/dependency-overrides.test.ts` and `npm audit --omit=optional`.
