<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Update the existing web icon package from 1.63.0 to 1.64.0. The version-specific verification record must match the changed manifest requirement and lockfile pin; the dependency register's existing approval, consumer and layer decisions still apply.

Provenance: Checked https://registry.npmjs.org/lucide-react/1.64.0 on 2026-11-02. Its version, canonical registry tarball URL, SHA-512 integrity and license match package-lock.json. The registry advertises SLSA provenance attestations; those attestations were not independently verified.

License: ISC, unchanged from 1.63.0. The existing owner finding is retained.

Security: Compared both registry version records: runtime dependencies, optional dependencies, peer requirements and package scripts are unchanged. No install lifecycle hooks are introduced. The lockfile changes only the web requirement and the Lucide pin, with no added package names or locations. `npm audit` reports no lucide-react advisory; 13 moderate findings remain in existing transitive chains. No new dependency, override or advisory exception is added.
