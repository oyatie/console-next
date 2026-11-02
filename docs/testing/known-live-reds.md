<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Known live test failures

| Test | Observed failure | Follow-up |
| --- | --- | --- |
| `e2e/life.spec.ts:118` — fixed-term renewal | At line 126, the one-year preset has `aria-disabled="true"` because it exceeds the two-year limit. Clicking it times out. | Enter an over-limit date through the supported date field; preserve the disabled preset. |
| `e2e/lifecycle-trail.spec.ts:232` — intercompany transfer | Correction returned HTTP 409 with `lifecycle_void_unsupported`; rescind preview returned HTTP 200 without changing the transfer. The linked-case dialog then remained loading beyond the five-second wait at line 298. A focused rerun passed. | Investigate the intermittent linked-case read delay and rerun the full journey. |
| `e2e/lifecycle-trail.spec.ts:304` — hire case close | `guardRawIds` scans every text node, including the intentional refusal identifier in `CommandError`'s `<code>`. `lifecycle.refuse.close_blocked` is both that identifier and a catalog key, so the guard reports it even when the explanation is translated. Korean and English copy already exists; forced HTTP 409 state checks confirm the sentence, code and open-item remedy. | Distinguish machine-code metadata from unresolved translated copy in the guard. If the close still returns HTTP 409, inspect and complete the remaining blocking items before expecting closure. |
| `e2e/lifecycle-trail.spec.ts:334` — workplace appointment, today preset | The test retains a dialog locator named `전보` across a target change that can rename it `전근`; state tests cover the rename and today selection at 1440/390 px in light/dark themes. A live rerun passed today selection but failed at line 365 with zero filing preview rows. Its requests first included `variant=WORKPLACE_CHANGE`, then lost that variant when the effective date was selected. | Keep the shared date preset. Inspect target-selection persistence and the workplace-change variant, and follow the sheet's derived name when locating it and its submit action. |

Reproduce with `CONSOLE_APP_BIN` pointing to the built backend:

```sh
E2E_AGENT=live-verification E2E_WORKERS=1 E2E_AUTOSHARD=0 \
CONSOLE_REPO="$PWD" CONSOLE_APP_BIN="$CONSOLE_APP_BIN" \
npm run e2e:agent -- e2e/lifecycle-trail.spec.ts e2e/life.spec.ts \
  --project=parallel \
  --grep 'one intercompany transfer|a renewal past the two-year fixed-term limit'
```

## Access roles after go-live

- Owner: People access. Review by 2026-11-09.
- Spec: `e2e/access-roles.spec.ts:121`, Chromium, base `14217620e`.
- Reproduce: `CONSOLE_APP_BIN=<console-app binary> E2E_AGENT=1 E2E_SLOT=<isolated slot> E2E_WORKERS=1 npx playwright test e2e/access-roles.spec.ts --project=parallel`.
- Immediate cause: the assertion expects the former heading `인사`; `People` now renders `roster.head.title` (`직원`).
- Changing only that assertion would hide a product defect. The base trace shows the worker's `/api/v1/access/me` returning ENFORCED `hr_basic/view` and `org/view` grants over LEGAL_ENTITY after go-live, while `/people` renders `access_denied` and never requests `/api/v1/employees`.
- Cause of that refusal: `PeopleDirectory` in `apps/web/src/features/people/People.tsx` still decides directory access using `granted(authz.data?.capabilities)`. The trace's only worker `/api/v1/me/authz` read is before the grant and returns an empty capability list; it is not refreshed when the worker opens `/people`. The fresh Cedar-backed access read and the retained legacy capability snapshot disagree.
- A diagnostic run with the heading corrected also reaches a second stale assertion: the last `getByText("접근 권한이 없습니다")` matches both the refusal heading and the live route announcement. Use a heading locator when repairing the journey.
- Hand-off: migrate the People directory/account choice and refusal to the server's Cedar decisions, with one fact loader; prove the already-signed-in worker reaches the roster after go-live. Then update the two locators and assert roster content, so a visible page heading alone cannot pass the journey. Do not add a client grant rule or bypass the refusal.
- The spec remains enabled.

## Cancelled unload mutes the error beacon

- Owner: Error beacon.
- File: `apps/web/public/error-beacon.js`.
- Reproduced on `14217620e`: dispatch `beforeunload`, let all queued callbacks run without `pagehide` or `pageshow`, then dispatch an `error` event. Zero reports are sent; dispatching `pageshow` restores reporting.
- Cause: `beforeunload` sets `leaving = true`; only `pageshow` clears it. Cancelling navigation keeps the same document and need not emit `pageshow`, so later real failures remain muted indefinitely.
- Hand-off: reset the tentative unload mute if the document stays active, while preserving suppression of Firefox's aborted imports before `pagehide`, real unload suppression, bfcache restoration, deduplication and the report cap. Add fake-clock and Chromium regressions for a cancelled unload and the existing real-navigation case in `e2e/mock/error-beacon-navigation.spec.ts`.
