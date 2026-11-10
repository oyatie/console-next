<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Known live test failures

Focused evidence on 2026-11-03 used frontend `76de1ad50`, backend `a5125793d`, the served Chromium shape,
one worker, and CI retry/flaky semantics. It produced 4 passes, 1 owned fixme skip and these 6 failures;
every retry failed earlier in tenant bootstrap, so the first-attempt product failure remains the evidence.
The table also retains the separately observed bulk-registration failures.

| Test | Owner | Observed failure | Follow-up |
| --- | --- | --- | --- |
| `e2e/live.spec.ts:118` — Home setup update without a refresh press | `@jason931225` | On frontend `01c5a309e`, Chromium and Firefox time out waiting for the action-inbox response after another session changes setup. Home holds live changes until its refresh control is pressed; the same timeout occurs with the in-list chip. | Reconcile the automatic-refresh premise with Home's notice hold, preserving the no-polling and one-press refresh checks. The spec remains enabled. |
| `e2e/person-pickers.spec.ts:28` — namesake selection | `@jason931225` | The picker stability check scored 0.0552 against the 0.02 budget. The attendance popup contributed 0.0473 when it grew from 229 to 291 px and flipped from below the field to above it; moving controls on `/people/new` contributed another 0.0064. | Stabilize popup placement while results change and keep the people-list controls fixed. Preserve readable labels and namesake confirmation. |
| `e2e/j6-bulk.spec.ts` — roster after registration | Unassigned | The roster filter band, row-height control and column picker move 4 px about 88 ms after input on `/people/new`. The accessibility stability assertion catches this arrival shift. | Keep the stability assertion enabled; fix the controls' layout during registration. |
| `e2e/j6-bulk.spec.ts` — paste commit landing | Unassigned | After a paste batch is recorded, the sheet closes onto the appointments tab's empty bulk workspace instead of the updated roster. The immediate result-row assertions fail. | Return to the recorded result after commit; preserve the assertions without navigating back to the roster in the test. |
| `e2e/life.spec.ts:12` — stale lifecycle sheet | `@jason931225` | The history list shifted by 0.0293 while stale-change rows settled. A status notice then covered the `발령` action until the 120-second timeout. | Stabilize history-row insertion and keep notices from covering record actions. |
| `e2e/life.spec.ts:118` — fixed-term renewal | `@jason931225` | At line 126, the one-year preset has `aria-disabled="true"` and the title says it exceeds the two-year limit. Clicking it times out. | Enter an over-limit date through the supported date field; preserve the disabled preset. |
| `e2e/lifecycle-trail.spec.ts:304` — hire case close | `@jason931225` | The people-list controls moved during the attestation audit. After passkey confirmation, the `증빙 확인 완료` dialog stayed visible, so the journey never reached case closure or the former raw-ID assertion. The raw-copy guard's false positive is fixed: `CommandError` marks diagnostic codes with `<code translate="no">`, which the guard preserves literally. Adjacent explanations and unmarked code remain checked. Forced HTTP 409 state tests cover the translated sentence, diagnostic code and blocking-item remedy in both browsers at desktop/phone widths and light/dark themes. | Keep the list controls fixed and close the dialog after successful attestation, then re-evaluate the later close refusal. A genuine `lifecycle.refuse.close_blocked` refusal can still keep the case open. Inspect and complete the remaining blocking items before expecting closure; the live journey still needs a successful rerun. |
| `e2e/lifecycle-trail.spec.ts:334` — workplace appointment | `@jason931225` | The target change can rename the retained `전보` dialog to `전근`; the today-preset locator then waited until the 240-second timeout. The filing preview was not reached. | Follow the sheet's derived name after target selection, then verify target persistence, the today preset and the workplace-change filing variant. |
| `e2e/access-roles.spec.ts:121` — access after go-live | `@jason931225` | The journey still expects the former `인사` heading and fails before proving the roster. It also recorded a moving role-table control while a role was deleted. | Complete the Cedar-backed People access hand-off below, update the stale heading locator and stabilize the role row. |

The previously listed `e2e/lifecycle-trail.spec.ts:232` intercompany-transfer journey passed in this focused run
and is no longer a current red; keep measuring it for the earlier intermittent linked-case delay.

Reproduce with `CONSOLE_APP_BIN` pointing to the built backend:

```sh
E2E_AGENT=live-verification E2E_WORKERS=1 E2E_AUTOSHARD=0 \
CONSOLE_REPO="$PWD" CONSOLE_APP_BIN="$CONSOLE_APP_BIN" \
npm run e2e:agent -- e2e/lifecycle-trail.spec.ts e2e/life.spec.ts \
  --project=parallel \
  --grep 'one intercompany transfer|a renewal past the two-year fixed-term limit'
```

## Access roles after go-live

- Owner: `@jason931225` (People access). Review by 2026-11-09.
- Spec: `e2e/access-roles.spec.ts:121`, Chromium, frontend `76de1ad50`, backend `a5125793d`.
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
