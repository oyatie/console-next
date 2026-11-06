<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Update the existing web icon package from 1.64.0 to 1.65.0. The version-specific verification record must match the changed manifest requirement and lockfile pin; the dependency register's existing approval, consumer and layer decisions still apply.

Provenance: Checked https://registry.npmjs.org/lucide-react/1.65.0 on 2026-11-06 against 1.64.0. Its version, canonical registry tarball URL, SHA-512 integrity and license match package-lock.json. The registry advertises SLSA provenance attestations; those attestations were not independently verified.

License: ISC, unchanged from 1.64.0. The existing owner finding is retained.

Security: Compared both registry version records: runtime dependencies, optional dependencies, peer requirements and package scripts are unchanged. No install lifecycle hooks are introduced. The lockfile changes only the web requirement and the Lucide pin, with no added package names or locations. No new dependency, override or advisory exception is added.

Compared the published runtime JavaScript with 1.64.0: changes beyond release banners consolidate the copyright icon into the circle-letter-c alias and its exports. Neither icon is consumed by the console. `npm audit` reports zero advisories for the resolved npm tree.
