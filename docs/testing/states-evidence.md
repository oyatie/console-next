<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Route-state evidence

The CI `states-timings` job publishes `states.json` as the `states-evidence` artifact on dev pushes affecting web code, independently of backend or live-journey changes. It reuses the tested route inventory and duration-budgeted state reports, including red observations, before refreshing timings. Built-in Playwright JSON reports remain in `states-report-*`; no additional specs or PR jobs run to produce evidence.

```sh
node scripts/d8-module-routes.mjs .cache/states-evidence/routes.json
E2E_MODULES_FILE=.cache/states-evidence/routes.json PLAYWRIGHT_JSON_OUTPUT_FILE=.cache/states-evidence/playwright.json npm run e2e:states
python3 scripts/states-evidence.py .cache/states-evidence/states.json .cache/states-evidence/routes.json .cache/states-evidence/playwright.json
```

The envelope is `{commit, run_at, source_command, rows}`. The producer requires each report’s config metadata commit to match the tested checkout; `run_at` retains the earliest report's UTC timestamp. The producer refuses reports older than seven days or in the future. Rows contain `route`, `state`, `status` (`pass`, `fail`, `unknown`), `support_ref`, `reference_count`, `raw_server_text`, `floorplan`, and `declared_floorplan`.

Every app route has a row for loading, failed, empty and refused. The existing home, people and org matrix emits `screen-state` attachments after its assertions at desktop and 390 px widths. Existing support-reference attachments supply failed, refused and no-reference observations across the wider route inventory. Routes without an executed observation remain `unknown`; no row is skipped. Failed retries stay red. Unexpected test outcomes, harness errors and unexecuted tests cannot pass. The producer records red rows in the artifact; only malformed or stale input fails the step.

Rendering a state successfully does not establish support-reference or floorplan conformance. The reader checks those fields independently for D8/D9. Row `kind` distinguishes general `screen-state` fixtures from dedicated `support-reference` probes, so intentionally reference-free fixtures cannot override reference proof; null references and missing declarations remain visible. This mocked evidence never raises D6 or establishes live support-reference resolution.

From the repository root, download and ingest the latest completed **ci dev push** set with the existing screens reader:

```sh
bash scripts/pull-measured-evidence.sh READER_DIR [OWNER/REPO]
```

This validates all three envelopes (`states`, `e2e`, `nextest`) before ingesting any. It checks the dev commit, report freshness and the reader's row schema. Failed and unknown rows stay unchanged. Missing artifacts fail explicitly; the command never selects an older successful run to hide a failed latest run. Before the standalone artifact rolls out, it accepts the existing `d8-evidence` states file. D7 inputs come from `d7-evidence` in the same run. Repository selection uses the argument, `GITHUB_REPOSITORY`, then `gh repo view`.

Then refresh scores from the checkout containing the reader:

```sh
python3 screens/build.py inventories
bash screens/ratchet.sh
```

Ingest enforces dev ancestry, envelope shape and UTC timestamps, then stamps `ingested_at`. It replaces the single states source, so combine all same-commit state reports in one producer invocation when collecting separate runs. A fresh source removes `measurement pending: states`. Unknown or missing states cannot raise D3 and preserve capture-held evidence; only observed failures lower it. D9 ignores unexecuted filler rows, requires at least one executed observation per route, and still refuses executed unknown or failing observations. Evidence names the affected routes.
