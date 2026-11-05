<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Route-state evidence

The independent `states-evidence` workflow runs on dev pushes and supports manual runs. It uses the existing duration-budgeted shard planner for the screen matrix and support-reference specs without a backend or live-E2E concurrency group. Its `states-evidence` artifact contains the router inventory, built-in Playwright JSON report and `states.json`, including failed runs.

```sh
node scripts/d8-module-routes.mjs .cache/states-evidence/routes.json
E2E_MODULES_FILE=.cache/states-evidence/routes.json PLAYWRIGHT_JSON_OUTPUT_FILE=.cache/states-evidence/playwright.json npm run e2e:states
python3 scripts/states-evidence.py .cache/states-evidence/states.json .cache/states-evidence/routes.json .cache/states-evidence/playwright.json
```

The envelope is `{commit, run_at, source_command, rows}`. The producer requires each report’s config metadata commit to match the tested checkout; `run_at` retains the earliest report's UTC timestamp. The producer refuses reports older than seven days or in the future. Rows contain `route`, `state`, `status` (`pass`, `fail`, `unknown`), `support_ref`, `reference_count`, `raw_server_text`, `floorplan`, and `declared_floorplan`.

Every app route has a row for loading, failed, empty and refused. The existing home, people and org matrix emits `screen-state` attachments after its assertions at desktop and 390 px widths. Existing support-reference attachments supply failed, refused and no-reference observations across the wider route inventory. Routes without an executed observation remain `unknown`; no row is skipped. Failed retries stay red. Unexpected test outcomes, harness errors and unexecuted tests cannot pass. The producer writes the artifact before returning failure for any red row.

Rendering a state successfully does not establish support-reference or floorplan conformance. The reader checks those fields independently for D8/D9. Row `kind` distinguishes general `screen-state` fixtures from dedicated `support-reference` probes, so intentionally reference-free fixtures cannot override reference proof; null references and missing declarations remain visible. This mocked evidence never raises D6 or establishes live support-reference resolution.

Download the artifact from a **dev push** matching its commit, then run from the checkout containing the screens reader:

```sh
python3 screens/evidence.py ingest ARTIFACT_DIR/states.json
python3 screens/build.py inventories
python3 screens/build.py check
```

Ingest enforces dev ancestry, envelope shape and UTC timestamps, then stamps `ingested_at`. It replaces the single states source, so combine all same-commit state reports in one producer invocation when collecting separate runs. A fresh source removes `measurement pending: states`; unknown and failed rows still prevent maturity increases and name the affected routes.
