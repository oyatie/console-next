<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# D7 journey evidence

The merge queue runs the solo journey on Chromium and Firefox and the existing client-error beacon on Chromium. The beacon has its own step and report artifact, so a failed write census cannot suppress it. Dev pushes consume those reports and publish `e2e-evidence` independently of backend changes, then publish `nextest-evidence` when backend reports exist. Each envelope retains the checked-out commit and its reports' original UTC start times. A failed E2E normalization cannot suppress nextest publication. These producers add no PR jobs or browser runs. When both envelopes are produced, `d7-evidence` retains the combined pair for existing consumers. The producer retains failing journey steps and negative tests; skips, missing results and ambiguous Rust names cannot supply green. A failed retry remains red. No reports older than seven days are republished.

From this repository, pull the latest completed **dev push** run with every available source:

```sh
bash scripts/pull-measured-evidence.sh READER_DIR [REPO]
```

For an older run with the combined pair, select its run ID explicitly: `READER_DIR` must be the directory containing `evidence.py`; there is no default checkout path:

```sh
bash scripts/pull-d7-evidence.sh RUN_ID READER_DIR [REPO]
```

`REPO` is optional (`owner/name`); it defaults to `GITHUB_REPOSITORY`, then `gh repo view` discovery. The command checks the run's branch/event, commit and freshness before calling the reader's ancestry and shape validation. Refresh module scores with the reader's inventory command and existing module/journey map. Set `EVIDENCE_READER_DIR` to the same directory to include the reader integration test in `python3 scripts/d7_evidence_test.py`.

At the release unit, reuse the targeted proof's reports: run each browser with `E2E_REPORTER=line,json` and a distinct `PLAYWRIGHT_JSON_OUTPUT_FILE`, then run `python3 scripts/d7-evidence.py OUTPUT_DIR NEXTEST_JUNIT PLAYWRIGHT_JSON...` once against those reports and nextest's JUnit. To normalize one source without the other tool's reports, use:

```sh
python3 scripts/d7-evidence.py --source e2e OUTPUT_DIR PLAYWRIGHT_JSON...
python3 scripts/d7-evidence.py --source nextest OUTPUT_DIR NEXTEST_JUNIT...
```

The producer does not rerun tests. `NEXTEST_JUNIT` also accepts a directory of shard reports; all nested `junit.xml` files contribute rows and retain their original timestamps.

The producer reuses the OpenAPI refusal grammar and literal assertions in E2E/Rust tests. It joins Playwright by file and nested title, nextest by binary and full module/test title. Dynamic titles, helpers, Rust module path overrides and unsupported assertion forms remain uncovered; extend the index with regression proof when needed. CI nextest defers DB tests, so their refusals remain uncovered until INTEG supplies their JUnit. The solo flow has no J11 audit-search assertion: that journey remains missing evidence.
