<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Known live test failures

| Test | Observed failure | Follow-up |
| --- | --- | --- |
| `e2e/life.spec.ts:118` — fixed-term renewal | At line 126, the one-year preset has `aria-disabled="true"` because it exceeds the two-year limit. Clicking it times out. | Enter an over-limit date through the supported date field; preserve the disabled preset. |
| `e2e/lifecycle-trail.spec.ts:232` — intercompany transfer | Correction returned HTTP 409 with `lifecycle_void_unsupported`; rescind preview returned HTTP 200 without changing the transfer. The linked-case dialog then remained loading beyond the five-second wait at line 298. A focused rerun passed. | Investigate the intermittent linked-case read delay and rerun the full journey. |

Reproduce with `CONSOLE_APP_BIN` pointing to the built backend:

```sh
E2E_AGENT=live-verification E2E_WORKERS=1 E2E_AUTOSHARD=0 \
CONSOLE_REPO="$PWD" CONSOLE_APP_BIN="$CONSOLE_APP_BIN" \
npm run e2e:agent -- e2e/lifecycle-trail.spec.ts e2e/life.spec.ts \
  --project=parallel \
  --grep 'one intercompany transfer|a renewal past the two-year fixed-term limit'
```
