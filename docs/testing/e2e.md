<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# E2E strategy

The [canonical tier table](README.md) owns triggers and budgets. E2E proves user journeys across the browser,
API and database. Business rules, refusals, Cedar scope decisions and edge cases belong in unit, component
(Vitest browser), API and DB tests. A rule discovered only in E2E must gain a lower-layer regression test.
Keep one spec per critical journey, the solo first-run gate and registry-driven route smoke.

## Budgets and authoring contract

PR affected specs run in Chromium and Firefox within **8 minutes wall**, including stack startup and teardown.
The release full suite runs once per release unit within **15 minutes wall**, using two-core CI jobs and shards
planned from recorded durations. The budget is the critical path of the whole tier, not the sum of shard CPU time.
Until CI-1 supplies runner evidence, neither budget is proven. Two workers on a many-core Mac is not a two-core run.

Create preconditions with the existing `e2e-test-support` API and `e2e/helpers/`, not UI clicks. Each test owns
its tenant and unique data. The solo first-run journey retains its UI setup. The next auth slice will reuse
signed-in `storageState` per role via a setup project, with separate mutable tenants per test/worker rather than
one shared account whose state tests race to change. Never commit session state or tokens.

Prefer `getByRole`, `getByLabel` and `getByText`, with web-first `expect(locator)`, `expect.poll` or `toPass`.
Avoid fixed sleeps, `waitForTimeout`, `networkidle`, forced actions and raw selectors in specs. Use `page.clock`
for browser time; backend lifecycle-clock tests remain in the serial `clock` project. Fake third parties at the
boundary using the NTS fake pattern. Visual comparisons belong in the visual project with reviewed baselines.

New specs declare a journey (`@journey:<name>`) and tier (`@tier:pr`, `@tier:queue`, `@tier:release`,
`@tier:stability` or `@tier:visual`) in Playwright test/describe tags or titles. These are selection metadata;
adding a tag alone does not wire a CI tier. Existing untagged files are shrink-only debt in Slice 2.

Layout stability remains a product guarantee. Today `go()` checks it on every navigation and Chromium records
shifts from first paint. Remove that check only after a dedicated route-registry suite covers **every route at
1440 and 390**, checks the CLS budget and controls moving under the pointer, and passes independently.
Functional tests then assert function; the dedicated suite still fails on moving controls. No assertion,
retry policy, selector, seed, auth path or product access decision changes in this baseline slice.

## Honest results

CI already sets one retry, `failOnFlakyTests` and first-retry traces in `playwright.config.ts`; keep them.
Report retry-green as flaky separately from stable passes, unexpected failures and deliberate skips.
A reproducible failure is product evidence; reproduce an uncertain red at the same revision and runner shape
before classifying it. Do not retry it away. Quarantine requires an owner, reason and expiry and stays counted;
there is no silent skip allowance. Track per-spec duration and flake rate over time from the raw JSON artifacts.

## Baseline protocol and evidence

Baseline revision: `6c77f338c8aab12dc903f5b2cb1a5d61b280dddf` (2026-10-26).
There are **no qualifying three-run artifacts in this checkout**. The public tree also omits `ops/compose.yml`;
full browser proof belongs to the external verifier with the curated stack. Do not substitute the brief's
91–94 historical reds or the existing passing-only EWMA timing cache for measured results.

| Metric | Before (three 2-core runs) | After Slice 1 |
| --- | --- | --- |
| Full-suite wall p50 / p95, each browser | Pending verifier collection | Pending; execution behaviour unchanged |
| Per-spec p50 / p95, each project | Pending verifier collection | Pending; collector added |
| Flaky / executed, each browser | Pending verifier collection | Pending; retry-green and failures retained |

On an isolated Linux runner allocated exactly two cores, with the existing stack prerequisites and a backend
built with `full,e2e-test-support`, run:

```sh
CONSOLE_APP_BIN=/path/to/console-app node scripts/e2e-baseline.mjs reports/e2e-baseline
```

The collector refuses another runner shape, runs three full repetitions **per browser** with `CI=1`, two workers,
one retry and fresh stack resets, and retains six raw Playwright JSON reports plus `baseline.json` at the supplied
path. Use the same built frontend/backend revision and runner image for all repetitions. Do not run repetitions
concurrently. Cold startup and teardown are included in measured subprocess wall time; record the runner image,
CPU allocation, dependency/cache state and stack image digests alongside the artifacts. Do not upload traces or
reports until CI's personal-data scan passes. A test red keeps the collector red while retaining measurements.
A setup error, interruption or unexpectedly unexecuted dependency test is an incomplete run, not a zero-duration
pass. Replace incomplete runs with complete evidence before accepting a baseline.

Per-spec samples are the sum of test-attempt durations (including retries and failures) per project/file per run;
these are work durations, not that file's parallel wall time. Across three comparable runs, p50/p95 use nearest
rank (p95 is therefore the maximum, a coarse baseline). Flake rate is the total Playwright `flaky` outcomes divided
by executed logical tests across repetitions; deliberate skips are excluded and failed outcomes stay counted.
Coverage must match across all three runs. Fill the table from `baseline.json` and retain the revision-bound raw
artifacts before calling Slice 1 measurement complete. Repeat the same protocol for later behaviour changes.

## Ordered delivery

1. Baseline collector, recorded three-run evidence, budgets and tiers (evidence pending verifier).
2. Practices guard in `npm run check`, shrink-only existing debt and fail-before controls for each rule.
3. Auth setup project and API preconditions, preserving the solo UI gate.
4. Registry-driven stability suite before removing navigation checks.
5. Lean services by tag, affected/both-browser CI tiers and two-core heavy-data sizing.
6. Reproduce and fix or quarantine E2E-DEV-HEALTH; zero unowned reds.

CI-1 owns `.github/workflows/ci.yml`. NEEDS-RESCOPE: add
`- run: node scripts/e2e-baseline.mjs reports/e2e-baseline` to its manually triggered baseline job on a two-core
Linux runner after stack/backend preparation; reuse its scanned artifact upload for `reports/e2e-baseline`.
Keep this expensive measurement out of each lane and routine PR jobs. CI-1 also owns `docs/ci.md`; link its tier
section to [the canonical table](README.md). This lane does not edit either owned file.

References: [Playwright best practices](https://playwright.dev/docs/best-practices),
[authentication](https://playwright.dev/docs/auth), [clock](https://playwright.dev/docs/clock),
[sharding](https://playwright.dev/docs/test-sharding).
