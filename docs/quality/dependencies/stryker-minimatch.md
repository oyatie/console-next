<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Stryker 10.1.1 requires minimatch ~10.2.4. The scoped override patches its glob matcher while retaining Stryker and its existing mutation-testing configuration.

Provenance: [minimatch 11.0.1 registry metadata](https://registry.npmjs.org/minimatch/11.0.1) supplies the version, tarball and SHA-512 integrity recorded in package-lock.json. Its Node engine supports the repository's Node 26 runtime.

License: BlueOak-1.0.0, as recorded in npm metadata and the lockfile.

Security: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) affects minimatch >=7.0.0 <11.0.1. This override is limited to the existing Stryker tooling dependency; it does not add an application dependency.

Removal condition: Remove once Stryker depends on minimatch >=11.0.1. Regenerate the lockfile and rerun the resolution test and a focused mutation run without the override.

Verification: scripts/dependency-overrides.test.ts checks the scoped manifest requirement, lock integrity, ledger and installed Stryker resolution. Run a focused Stryker mutation pass to verify its glob discovery and test execution with the patched matcher.
