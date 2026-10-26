<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

# Contract-backed screen states

Run the Chromium matrix with Vite alone (no Rust build, backend or database).
The normal journey config excludes these specs:

```sh
npx playwright test --config e2e/mock/playwright.config.ts
npx playwright test --config e2e/mock/playwright.config.ts --grep 'people: loading at 390'
```

Use the existing `E2E_SLOT` / `CONSOLE_WEB_PORT` environment variables to isolate
concurrent runs. The config starts its own Vite and never reuses another run's
server. Each test has a fresh browser context. Service workers are blocked.

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
none; it never falls through to a real backend. Vite's `packages/api/` module
URLs remain ordinary source requests. Loading reads are held until cleanup,
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
plus loading, failed, refused, long text and a 2,000-event history. These are read
states; command success/refusal journeys remain real-backend release gates.

The list uses the existing table's phone cards; its shared component proof is
`apps/web/src/ui/long-table/phone-tables.browser.test.tsx` and the table examples
are in `/_gallery`. The regression was reproduced on bd22bc6: populated and long
lists overflowed the main column by 17 px at 390 px before enabling card roles.

Remaining sweep batches, in order: organization list/outline/selection and move;
personnel card and register; bulk and renewals; exits, notices and certificates;
remaining HR reference screens. Lane-budget policy follows the screen sweep.
