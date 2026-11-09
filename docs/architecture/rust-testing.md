<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Rust test execution

The owner approved cargo-nextest as Rust tooling on 2026-10-28. Its approved layer is CI test execution,
with the same local invocation for reproducible proofs. It does not enter the application runtime.

| Tool | Layer | User | Approval | Exit plan |
| --- | --- | --- | --- | --- |
| `ci-tool:nextest` | CI/supply chain | `.github/workflows/ci.yml` | Owner, 2026-10-28: cargo-nextest approved as Rust tooling | Replace only with test discovery, isolation, failure propagation and JUnit parity. |
| `action:actions/cache/restore` | CI/supply chain | `.github/workflows/ci.yml` | Owner, 2026-10-29: cache actions approved; `approval.by = owner`; `authority = Owner` | Remove the cache steps; all checks continue with cold builds. |
| `action:actions/cache/save` | CI/supply chain | `.github/workflows/ci.yml` | Owner, 2026-10-29: cache actions approved; `approval.by = owner`; `authority = Owner` | Remove the cache steps; all checks continue with cold builds. |

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
published beside JUnit in the `backend-test-results-<shard>` artifacts. No baseline test list is checked in.

Nextest shards run alongside clippy, gates and the release build, restoring the same trusted cache.
The Rust cache covers both builds, keyed by runner OS/architecture, toolchain, manifests, lockfile and
commit. Only successful pushes to dev save it; pull requests and merge groups only restore it.
Incremental compilation is disabled to limit cache size. A warm hosted run targets ten minutes including
restore and upload; the first run or a changed dependency key builds cold and can exceed that target.
Hosted summaries must establish the actual timing; the local cold proof took about seventeen minutes.
The served Home budget runs on every candidate. Backend changes use the current release artifact;
web-only candidates download `d10-backend` from the latest successful same-repository dev CI push.
Dev release artifacts are retained for 90 days; a missing trusted artifact fails the job.
The job summary reports selected and deferred cases, naming each existing
`#[ignore]` case. Deferred totals include listed database tests, explicitly ignored cases, and SQLx
source declarations absent from the default-feature inventory (including `test-postgres`-only tests).
The last bucket counts declarations, without a second feature build; the complete declaration list is
in the inventory artifact. These cases remain visible debt and are not counted as passing tests.
JUnit must contain every selected identity exactly once, without skips, failures or errors, and nextest
must exit successfully. Any discrepancy fails `backend-tests` and the required `ci-ok` aggregate.
The runner uses the existing [CI JUnit profile](../../.config/nextest.toml), with no retries and no early
exit after the first failure.

Run `node scripts/backend-tests.mjs --db` with `DATABASE_URL` for the database selection. The command
enables the workspace `test-postgres` features and the app's full, E2E-fixture and development-auth
test surfaces, then selects SQLx tests and ordinary tests absent from the default-feature inventory;
there is no checked-in test list.
The `db-tests` workflow runs for gate-changing pull requests, dev pushes and nightly
against the pinned PostgreSQL service image. It provisions the repository’s role topology with
`deploy/dev/postgres-init.sh`, rotates the bootstrap password, and supplies random role credentials
to the shared fixtures. The migration connection uses `console_buck_admin` on a `_contract` database
with the explicit SQLx bootstrap startup option. Four jobs are packed from
the latest same-repository JUnit durations, with equal weights only when no measurement exists yet.
Tests excluded by the development-auth feature run from a derived default-feature variant in the same
plan, so mutually exclusive feature guards cannot make either side disappear.
Before cache restore, each database shard removes the unused hosted .NET, Swift and CodeQL SDKs
from `/usr/share/dotnet`, `/usr/share/swift` and `/opt/hostedtoolcache/CodeQL`.
These are disposable tools from the [hosted runner image](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Arm64-Readme.md);
Rust, Node, Docker, the PostgreSQL service and restored build artifacts stay available.
The job logs free disk before and after cleanup, and after the build/tests even if they fail.
`CARGO_PROFILE_TEST_DEBUG=0` omits test debug information to reduce linker disk usage for both
feature variants; hosted failure backtraces lack source lines. The cache key includes this setting so
previous debug artifacts do not consume the reclaimed disk. Local test profiles retain line tables.
Their reports are reconciled into one exact inventory before new timings are trusted. Source ignores
must carry an owner, reason and a staggered, unexpired review date. Manual generators use
`kind=generator` instead of an expiry because they are tools, not quarantined assertions. Only workspace
member sources are subject to this policy; dependency tests are outside this repository’s ownership.
During the seven days before expiry, the job emits annotations and step-summary warnings identifying
the owner and deadline. Fix and unignore the test, or review its reason and renew the expiry before
the deadline; an expired quarantine fails discovery.
Database ignores remain quarantined until their review date and
their exact identities stay in the published inventory; the runner never broadens selection with
`--run-ignored all`.

Tests with `budget` in their names reserve all test slots through
[nextest’s heavy-test configuration](https://www.nexte.st/docs/configuration/threads-required/),
so other migrations cannot interfere with their samples.
