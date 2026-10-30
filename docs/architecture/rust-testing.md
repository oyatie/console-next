<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Rust test execution

The owner approved cargo-nextest as Rust tooling on 2026-10-28. Its approved layer is CI test execution,
with the same local invocation for reproducible proofs. It does not enter the application runtime.

| Tool | Layer | User | Approval | Exit plan |
| --- | --- | --- | --- | --- |
| `ci-tool:nextest` | CI/supply chain | `.github/workflows/ci.yml` | Owner, 2026-10-28: cargo-nextest approved as Rust tooling | Replace only with test discovery, isolation, failure propagation and JUnit parity. |
| `actions/cache/restore`, `actions/cache/save` | CI/supply chain | `.github/workflows/ci.yml` | Owner, 2026-10-29: cache actions approved; `approval.by = owner`; `authority = Owner` | Remove the cache steps; all checks still run on a cold build. |

The owner approved the cache actions on 2026-10-29, following the 2026-10-28 directive:
「caching should work following best practices both in github and locally」.
The five STANDARD criteria are: (a) GitHub's first-party action and
[documented caching mechanism](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching);
(b) [MIT licensed](https://github.com/actions/cache/blob/55cc8345863c7cc4c66a329aec7e433d2d1c52a9/LICENSE);
(c) maintained by GitHub, with [v6.1.0 released on 2026-06-26](https://github.com/actions/cache/releases/tag/v6.1.0);
(d) a lightweight [CI action](https://github.com/actions/cache) with no application runtime dependency;
(e) confined to the CI/supply chain layer and the workflow above, removable without affecting build correctness.
Both actions are pinned to commit `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` (`v6.1.0`).

The workflow pins the upstream release and verifies its archive's SHA-256 before execution. Nextest is
MIT OR Apache-2.0 licensed. The [canonical test tiers](../testing/README.md) own test selection and budgets;
the existing [nextest configuration](../../.config/nextest.toml) owns execution and JUnit settings.

Run `node scripts/backend-tests.mjs` for the same non-database selection as CI. It builds with
`cargo nextest list --workspace --locked`, derives database cases from existing `#[sqlx::test]`
attributes within each Cargo package and runs the remaining tests, including ordinary tests in mixed
binaries, including cases emitted by SQLx test macros. The `test-postgres` features stay disabled;
the container-backed census opts in through `console-gate-writer-ownership/test-postgres`.
Ambiguous names or unsupported test macro signatures fail classification.
Database connection environment variables are removed for this run: a missing database failure is a
classification defect, not a reason to add an exclusion. The filter and complete identity inventory are
published beside JUnit in the `backend-test-results` artifact. No baseline test list is checked in.

Nextest runs after clippy in the backend job, sharing its registry and target directory.
The Rust cache covers both builds, keyed by runner OS/architecture, toolchain, manifests, lockfile and
commit. Only successful pushes to dev save it; pull requests and merge groups only restore it.
Incremental compilation is disabled to limit cache size. A warm hosted run targets ten minutes including
restore and upload; the first run or a changed dependency key builds cold and can exceed that target.
Hosted summaries must establish the actual timing; the local cold proof took about seventeen minutes.
The job summary reports selected and deferred cases, naming each existing
`#[ignore]` case. Deferred totals include listed database tests, explicitly ignored cases, and SQLx
source declarations absent from the default-feature inventory (including `test-postgres`-only tests).
The last bucket counts declarations, without a second feature build; the complete declaration list is
in the inventory artifact. These cases remain visible debt and are not counted as passing tests.
JUnit must contain every selected identity exactly once, without skips, failures or errors, and nextest
must exit successfully. Any discrepancy fails `backend` and the required `ci-ok` aggregate.
The runner uses the existing [CI JUnit profile](../../.config/nextest.toml), with no retries and no early
exit after the first failure. Database test execution and its Postgres role topology are the next step;
no database tests are claimed as executed by this tier.
