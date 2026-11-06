<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Rust advisory exceptions

The enforced expiry dates live in `backend/deny.toml` and
`backend/.cargo/audit.toml`. `scripts/check-audit-ignores.mjs` rejects expired,
unreasoned, or unmirrored exceptions. Exceptions accept risk temporarily; they
do not count as remediation.

| Advisory | Affected dependency path | Rationale and remaining risk | Exit / review action |
| --- | --- | --- | --- |
| [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) | rsa 0.9.10 retained by sqlx 0.8's optional MySQL metadata through apalis-postgres | The crate is absent from Cargo's resolved all-target graph, so this RSA implementation is not compiled. `cargo audit` still scans every lockfile entry. | Remove the exception when the jobs stack moves to sqlx 0.9 or rsa publishes a fixed release; review by 2027-01-07. |
| [RUSTSEC-2024-0436](https://rustsec.org/advisories/RUSTSEC-2024-0436.html) | paste via umya-spreadsheet | This is an unmaintained build-time proc macro, not a vulnerability; it has no runtime attack surface. | Replace the transitive package when the spreadsheet stack permits it; review by 2027-01-07. |
| [RUSTSEC-2026-0441](https://rustsec.org/advisories/RUSTSEC-2026-0441.html) | pin-utils 0.1.0 via async-imap 0.11.2 (console-comms-adapter-imap) | Unmaintained, not a vulnerability: upstream archived 2026-10-01. async-imap 0.12.0 still depends on it, so no upgrade removes it. The IMAP adapter is part of comms, which is not in the MVP. | Review by 2027-02-05: drop the ignore once async-imap moves to core::pin::pin! / pin-project, or replace the dependency. |

RUSTSEC-2026-0387 was removed from this ledger on 2026-11-03 after the curve
stack moved to crypto-bigint 0.7.10 through p256 0.14.0.
