<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

# Contract-backed screen states

Run the Chromium matrix against a production Vite build (no Rust build, backend or database).
The normal journey config excludes these specs:

```sh
npm run e2e:states
npm run e2e:states -- --grep 'people: loading at 390'
```

CI plans duration-balanced shards before running this suite with Chromium headless
shell. `timings.json` owns the ten-minute target, five-shard cap, startup allowance,
worker count and per-test bootstrap floor. It contains no per-spec measurements.
The planner stretches the target only within the execution limit:
`min(timeoutSeconds, floor(runLimitSeconds / RUN_HEADROOM))` (currently 937 seconds).
`RUN_HEADROOM` is 1.6; each run step gets `ceil(planned budget × 1.6 / 60)`
minutes and Playwright uses the same unrounded timeout in seconds. The job adds
`ceil(setupAllowanceSeconds / 60)` minutes for checkout, npm, browser setup and artifacts.
These are timeout ceilings, not target durations.

The browser cache uses the exact installed Playwright version, OS and architecture.
Only dev pushes save it; PRs restore without publishing. `--with-deps` still runs
on cache hits because browser archives do not include the OS fonts needed by screenshots.

Five state runners plus the other PR workflows stay within the 20-runner allowance;
`scripts/ci-backend.test.mjs` checks the combined fan-out. `states-plan` lists runnable
specs and packs whole files longest first. Every matrix job downloads that exact plan
and runs its file list; `ci-ok` requires the planner and every shard.
A spec exceeding the execution limit fails with `STATES_SPEC_OVER_BUDGET` and its path.
If five shards cannot fit, planning fails with `STATES_TIMEOUT_LIMIT`. Missing
measurements are named in the error; optimize or split oversized specs rather than
adding a committed timing row.

Successful dev pushes publish per-spec wall durations and the measurement's worker
count as `states-timings`. Plans restore the latest unexpired same-repository dev
artifact with matching workers. Artifact lookup examines at most five pages of 100
entries. If no compatible artifact exists, the newest trusted artifact is scaled by
`measured workers / configured workers`, with a warning. If none exists, the configured
four worker-seconds per test bootstrap the suite, also with a warning. This floor
allows the initial run to produce measurements; it is not a capacity proof.
Partial, failed, duplicate or worker-mismatched reports cannot refresh measurements.
CI never overwrites the committed settings.

Unknown specs and added tests use the nearest-rank **P95** of measured worker-seconds
per test (`seconds × workers / tests`), with `defaultTestSeconds` as a floor.
The planner converts these estimates for the shared packer. The dev-push timings job
publishes complete measurements before checking the unchanged **15% headroom** bar
and growth of 30 tests plus 10% drift. A noisy dev sample reports capacity debt there
without failing unrelated PRs' capacity checks. PRs still enforce packing limits,
exact selections and passing state assertions.

Run planner regressions locally with `node --test scripts/states-shards.test.mjs`.
To include the dev capacity check, first restore measurements with a read-only token
and the repository environment used by Actions:

```sh
node scripts/states-shards.mjs restore e2e/mock/timings.json .cache/states-timings/timings.json
STATES_CHECK_CAPACITY=1 node --test scripts/states-shards.test.mjs
```

The capacity test skips with a reason outside the dev job; a requested local capacity
check also skips when its artifact file is absent. CI treats a missing artifact as an error.
Local measurements must never overwrite CI's trusted artifact.

Use the existing `E2E_SLOT` / `CONSOLE_WEB_PORT` environment variables to isolate
concurrent runs. The config builds the web app once, then starts Vite preview on
the slot's strict port and never reuses another run's server. Vite's `test` mode
includes `/_gallery` in this optimized build under `.cache/states-<port>`;
normal production builds omit it, and their `apps/web/dist` output is preserved.
Lazy chunks are already built before assertions start; the same `page.route` mocks supply API
states. Each test has a fresh browser context. Service workers are blocked.

Fix-round proof (2026-10-27): `CONSOLE_WEB_PORT=5293 /usr/bin/time -p npm run e2e:states`
passed all 113 Chromium cases in **143.58 s wall time**, including the single build
and preview startup, with two workers, no retries and unchanged timeouts. The
pre-fix `cfeee3232` dev-server run passed its 104 cases in 208.32 s; the reported
department-head flake did not recur. Rebased `public/dev` added nine cases. An HTML
assertion rejected the base's dev entry and passed for preview's built assets.

`mockRoute(page, method, path, reply)` derives valid operations, response status
codes and JSON from `@console/api`'s generated `paths`. A reply can be a value or
an async request factory (for held reads, pagination or query filters). Path
parameters match exactly one segment; other methods fall through to earlier
handlers. Register parameter routes before exact routes: Playwright tries the
last handler first. Common middleware 403/503 failures use the generated `ErrorBody`.
`npm run typecheck` checks the negative contract assertions in `route.spec.ts`.
Never cast a fixture to fit, edit generated types, or add a dependency.

`screen.ts` mocks every supporting read, including session restoration and the
existing server access projection. It introduces no authorization rule. The
catch-all rejects unregistered API requests and the suite asserts there were
none; it never falls through to a real backend. Loading reads are held until cleanup,
without sleeps. Playwright buffers fulfilled response bodies, so a browser
ReadableStream supplies the healthy SSE connection without events. Failed reads
exhaust the product's real retry budget.

The executable screen registry is [../states/registry.ts](../states/registry.ts).
Its screen records carry the central screen registry IDs; every listed state is crossed with its screen at 1440 and 390 px. Each
case runs the shared WCAG 2.2 AA axe scanner in light and dark. Live journey
tests retain their arrival-layout checks; these tests prove the held or settled
state. The large fixture contains 2,000 records: inbox and roster replies page
them, and the chart contains 2,000 departments. The suite proves inbox load-more
and bounded roster DOM as well as the states themselves.
The roster uses opaque row-id cursors and signals exhaustion with `next_cursor:
null`; its large case scrolls through every page and rejects offset requests.

`org-change-counts.spec.ts` covers loading/failed counts at both widths, including
recovery from a held read. The existing count component reserves space while
loading and shows a dash with a failure reason; a successful zero stays zero.
The list fixture mixes drafters and effective dates so selecting my changes and
clearing an inclusive date range proves both the request and visible rows.

For a new screen, add typed fixtures and a screen record with its primary read,
production route, central registry ID and real-backend journey spec. Add every
supporting read to `screen.ts`. Run the matrix before opening a PR.
Keep each state below one minute.

The `live` field names the existing real-backend release gate for each surface;
mock results do not substitute for it. Web-only live checks set `CONSOLE_APP_BIN` to a
prebuilt backend binary and use the normal Playwright config. See Playwright's
[mocking guide](https://playwright.dev/docs/mock) and
[test isolation guidance](https://playwright.dev/docs/best-practices).

## Org/HR sweep: organization changes

`orgChangeScreens` adds the change list and record to the same matrix. Run their
44 state cases and saved-view/keyboard navigation proof with:

```sh
npx playwright test --config e2e/mock/playwright.config.ts e2e/states/org-changes.spec.ts
```

The list fixture honors the contract's comma-separated status filters, drafter,
effective-date range and offset/limit. Its 2,000-row state proves forward/back
paging with only 50 rows rendered. The record has no empty-list state: a missing
record returns 404. Its matrix covers draft (including legacy PRECHECKED),
approval, scheduled, applied, settling, rejected, cancelled and archived records,
plus loading, failed, refused, long text and a 2,000-event history (50 rendered
rows with next/previous paging, matching the shared timeline). These are read
states; command success/refusal journeys remain real-backend release gates.

The list uses the existing table's phone cards; its shared component proof is
`apps/web/src/ui/long-table/phone-tables.browser.test.tsx` and the table examples
are in `/_gallery`. The regression was reproduced on bd22bc6: populated and long
lists overflowed the main column by 17 px at 390 px before enabling card roles.

Remaining sweep batches, in order: organization list/outline/selection and move;
personnel card and register; bulk and renewals; exits, notices and certificates;
remaining HR reference screens. Lane-budget policy follows the screen sweep.
