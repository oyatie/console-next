<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Rust advisory exceptions

Reviewed 2026-10-27 under the owner's dependency-maintenance authorization. Review by
2026-11-27; that date is also the enforced expiry in `backend/deny.toml` and
`backend/.cargo/audit.toml`. `scripts/check-audit-ignores.mjs` rejects expired or
unmirrored exceptions. These exceptions accept risk temporarily, not remediation.

| Advisory | Affected dependency path | Rationale and remaining risk | Exit / review action |
| --- | --- | --- | --- |
| [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) | crypto-bigint 0.5.5 via elliptic-curve 0.13, p256/p384 0.13 | Secret-dependent arithmetic may leak timing information. Fixed only in crypto-bigint >=0.7.6; the existing curve dependencies cannot resolve that version. No claim that all downstream signing paths are immune. | Maintainers: review upstream curve releases and their consumers before 2026-11-27; upgrade with signing/verification compatibility proof, then remove both ignores. |
| [RUSTSEC-2026-0441](https://rustsec.org/advisories/RUSTSEC-2026-0441.html) | pin-utils 0.1.0 via async-imap 0.11.2 (console-comms-adapter-imap) | Unmaintained, not a vulnerability: upstream archived 2026-10-01. async-imap 0.12.0 still depends on it, so no upgrade removes it. The IMAP adapter is part of comms, which is not in the MVP. | Review by 2027-02-05: drop the ignore once async-imap moves to core::pin::pin! / pin-project, or replace the dependency. |

The TLS trust and ctutils advisories are resolved by compatible lockfile upgrades,
and Tokio is moved to the patched 1.53.3 release; none receives an exception here.
