<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

Reason: Update the existing web icon package from 1.65.0 to 1.66.0. The version-specific verification record must match the changed manifest requirement and lockfile pin; the dependency register's existing approval, consumer and layer decisions still apply.

Provenance: Checked https://registry.npmjs.org/lucide-react/1.66.0 on 2026-11-08 against 1.65.0. Its version, canonical registry tarball URL, SHA-512 integrity and license match package-lock.json. The downloaded tarball matches the integrity hash. The registry advertises SLSA provenance attestations; those attestations were not independently verified.

License: ISC, unchanged from 1.65.0. The existing owner finding is retained.

Security: Compared both registry version records: runtime dependencies, optional dependencies, peer requirements and package scripts are unchanged. No install lifecycle hooks are introduced. The lockfile changes only the web requirement and the Lucide pin, with no added package names or locations. No new dependency, override or advisory exception is added.

Compared 2,290 existing published ESM modules with 1.65.0: changes beyond release banners add 17 icon modules and exports, and redraw circle-letter-p-off and square-letter-p-off. Neither changed icon nor their aliases are consumed by the console. The shared icon renderer is unchanged.
