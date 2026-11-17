<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Testing

See the [canonical test tiers](testing/README.md), [E2E strategy](testing/e2e.md)
and [known live test failures](testing/known-live-reds.md).

Choose the engine for the same mock and live specs with `E2E_BROWSER=chromium|firefox|webkit`.
For example, `E2E_BROWSER=webkit npm run e2e:states` runs mocked states, and
`E2E_BROWSER=webkit npm run e2e -- --project=webkit` runs live journeys.
The default is Chromium; `E2E_XBROWSER=1` remains a Firefox alias. An explicit
`E2E_BROWSER` takes precedence, and an unknown value fails configuration.
Install the browser build matching the locked Playwright version with
`npx playwright install webkit` (`--with-deps` on Linux).

WebKit is the Safari engine, not Safari itself; Safari storage and iOS rendering
are outside this coverage. Live clock tests and gallery visual baselines remain
Chromium-only. The non-resident security-key test in `e2e/sign-in-id.spec.ts`
explicitly skips non-Chromium engines because only CDP models that authenticator;
other passkey journeys use the existing context credential helper.
The `@webkit-pr` tag selects the focused WebKit set in the existing `home` PR and
merge-group job: solo onboarding, passkey-free code sign-in, inline chart editing,
keyboard focus, combobox selection, Sheet dismissal, date entry and org toolbar
hit targets. Mock cases include 390 px and dark coverage. Run it locally with
`E2E_BROWSER=webkit npm run e2e:states -- --grep @webkit-pr` and
`E2E_BROWSER=webkit npm run e2e -- e2e/first-run-solo.spec.ts --grep @webkit-pr`.
The job publishes per-spec results and traces as `webkit-pr`; no PR cases are
skipped for WebKit. Its 45-minute limit stays unchanged: hosted elapsed time,
including setup and existing work, must stay below 38m15s to retain 15% headroom.
Nightly full WebKit coverage remains pending.
