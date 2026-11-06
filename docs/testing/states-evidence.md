<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Route-state evidence

The CI `d10-evidence` job produces `states.json` once from the existing duration-budgeted state shards on dev pushes. The `d8-evidence` artifact contains this file alongside live write-probe and client-error evidence, including red state observations. Built-in Playwright JSON reports remain in `states-report-*`; no additional specs run to produce evidence.

```sh
node scripts/d8-module-routes.mjs .cache/states-evidence/routes.json
E2E_MODULES_FILE=.cache/states-evidence/routes.json PLAYWRIGHT_JSON_OUTPUT_FILE=.cache/states-evidence/playwright.json npm run e2e:states
python3 scripts/states-evidence.py .cache/states-evidence/states.json .cache/states-evidence/routes.json .cache/states-evidence/playwright.json
```

The envelope is `{commit, run_at, source_command, rows}`. The producer requires each report’s config metadata commit to match the tested checkout; `run_at` retains the earliest report's UTC timestamp. The producer refuses reports older than seven days or in the future. Rows contain `route`, `state`, `status` (`pass`, `fail`, `unknown`), `support_ref`, `reference_count`, `raw_server_text`, `floorplan`, and `declared_floorplan`.

Every app route has a row for loading, failed, empty and refused. The existing home, people and org matrix emits `screen-state` attachments after its assertions at desktop and 390 px widths. Existing support-reference attachments supply failed, refused and no-reference observations across the wider route inventory. Routes without an executed observation remain `unknown`; no row is skipped. Failed retries stay red. Unexpected test outcomes, harness errors and unexecuted tests cannot pass. The producer records red rows in the artifact; only malformed or stale input fails the step.

Rendering a state successfully does not establish support-reference or floorplan conformance. The reader checks those fields independently for D8/D9. Row `kind` distinguishes general `screen-state` fixtures from dedicated `support-reference` probes, so intentionally reference-free fixtures cannot override reference proof; null references and missing declarations remain visible. This mocked evidence never raises D6 or establishes live support-reference resolution.

Download the artifact from a **dev push** matching its commit, then run from the checkout containing the screens reader:

```sh
python3 screens/evidence.py ingest ARTIFACT_DIR/states.json
python3 screens/build.py inventories
bash screens/ratchet.sh
```

Ingest enforces dev ancestry, envelope shape and UTC timestamps, then stamps `ingested_at`. It replaces the single states source, so combine all same-commit state reports in one producer invocation when collecting separate runs. A fresh source removes `measurement pending: states`. Unknown or missing states cannot raise D3 and preserve capture-held evidence; only observed failures lower it. D9 ignores unexecuted filler rows, requires at least one executed observation per route, and still refuses executed unknown or failing observations. Evidence names the affected routes.
