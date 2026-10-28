<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Rust test execution

The owner approved cargo-nextest as Rust tooling on 2026-10-28. Its approved layer is CI test execution,
with the same local invocation for reproducible proofs. It does not enter the application runtime.

| Tool | Layer | User | Approval | Exit plan |
| --- | --- | --- | --- | --- |
| `ci-tool:nextest` | CI/supply chain | `.github/workflows/ci.yml` | Owner, 2026-10-28: cargo-nextest approved as Rust tooling | Replace only with test discovery, isolation, failure propagation and JUnit parity. |

The workflow pins the upstream release and verifies its archive's SHA-256 before execution. Nextest is
MIT OR Apache-2.0 licensed. The [canonical test tiers](../testing/README.md) own test selection and budgets;
the existing [nextest configuration](../../.config/nextest.toml) owns execution and JUnit settings.
