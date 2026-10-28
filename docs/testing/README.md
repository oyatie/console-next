<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Test tiers

This is the canonical tier table. The public workflow currently runs web checks, mocked browser states,
backend static gates and non-database Rust tests. Other rows describe the delivery contract.

| Tier | Proof | Trigger / budget |
| --- | --- | --- |
| Docs only | Documentation checks; no builds | Documentation-only changes |
| Fast | Types, lint, affected unit/component tests, contract and ratchet gates; affected API/DB binaries | PRs and fix rounds; affected only |
| Rust non-database | Every default-feature workspace test without a database; nextest JUnit reconciled against a fresh inventory | Every PR, push to dev and merge result; target ≤ 10 min wall, shard by measured duration above 5 min execution |
| PR browser | Affected critical journeys and first-run-solo smoke, Chromium and Firefox | Every PR; ≤ 8 min wall including stack startup |
| Queue browser | Affected checks, journey smoke, solo first-run gate, route smoke and a no-new-reds sweep | Landing / merge result; browser smoke within the PR budget |
| Full widening | Full suite for migrations, contracts, Cedar, auth/tenancy and tooling changes | When the change affects these shared boundaries |
| Release / nightly | Full DB suite and full Chromium/Firefox E2E | Once per release unit and nightly; E2E ≤ 15 min wall including startup |
| Scheduled | Mutation, soak, chaos and fuzz | Separate scheduled jobs |

Owner policy (2026-10-15): select crates through the workspace dependency graph, web tests through the import
graph and E2E through the feature map (the screen registry's spec-to-route map), plus first-run-solo smoke.
Fix rounds run affected checks; landing adds smoke and the no-new-reds sweep; releases and nightly run everything.
When unsure, widen the checks. Record a skipped suite as **not affected**, with evidence, never as a pass.

See [E2E strategy, measurement protocol and current evidence](e2e.md) for browser selection, tagging,
flake accounting and the distinction between current behaviour and the target.

Run `node scripts/backend-tests.mjs` for the same non-database selection as CI. It builds with
`cargo nextest list --workspace --locked`, derives database cases from existing `#[sqlx::test]`
attributes within each Cargo package and runs the remaining tests, including ordinary tests in mixed
binaries, including cases emitted by SQLx test macros. The `test-postgres` features stay disabled;
the container-backed census opts in through `console-gate-writer-ownership/test-postgres`.
Ambiguous names or unsupported test macro signatures fail classification.
Database connection environment variables are removed for this run: a missing database failure is a
classification defect, not a reason to add an exclusion. The filter and complete identity inventory are
published beside JUnit in the `backend-test-results` artifact. No baseline test list is checked in.

The job summary reports selected, database-deferred and explicitly ignored cases, naming each existing
`#[ignore]` case. Those declared ignores remain visible debt; they are not counted as passing tests.
JUnit must contain every selected identity exactly once, without skips, failures or errors, and nextest
must exit successfully. Any discrepancy fails `backend-tests` and the required `ci-ok` aggregate.
The runner uses the existing [CI JUnit profile](../../.config/nextest.toml), with no retries and no early
exit after the first failure. Database test execution and its Postgres role topology are the next step;
no database tests are claimed as executed by this tier.
