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
