<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# D7 journey evidence

On dev pushes, CI runs the solo journey on Chromium and Firefox and publishes `d7-evidence` with `e2e.json` and `nextest.json` stamped with the checked-out commit and the reports' original UTC start times. These runs and evidence publication add no PR gate. The producer retains failing journey steps and negative tests; skips, missing results and ambiguous Rust names cannot supply green. A failed retry remains red. No reports older than seven days are republished.

From this repository, pull one **dev push** run into the maturity evidence reader. `READER_DIR` must be the directory containing `evidence.py`; there is no default checkout path:

```sh
bash scripts/pull-d7-evidence.sh RUN_ID READER_DIR [REPO]
```

`REPO` is optional (`owner/name`); it defaults to `GITHUB_REPOSITORY`, then `gh repo view` discovery. The command checks the run's branch/event, commit and freshness before calling the reader's ancestry and shape validation. Refresh module scores with the reader's inventory command and existing module/journey map. Set `EVIDENCE_READER_DIR` to the same directory to include the reader integration test in `python3 scripts/d7_evidence_test.py`.

At the release unit, reuse the targeted proof's reports: run each browser with `E2E_REPORTER=line,json` and a distinct `PLAYWRIGHT_JSON_OUTPUT_FILE`, then run `python3 scripts/d7-evidence.py OUTPUT_DIR NEXTEST_JUNIT PLAYWRIGHT_JSON...` once against those reports and nextest's JUnit. The producer does not rerun tests.

The producer reuses the OpenAPI refusal grammar and literal assertions in E2E/Rust tests. It joins Playwright by file and nested title, nextest by binary and full module/test title. Dynamic titles, helpers, Rust module path overrides and unsupported assertion forms remain uncovered; extend the index with regression proof when needed. CI nextest defers DB tests, so their refusals remain uncovered until INTEG supplies their JUnit. The solo flow has no J11 audit-search assertion: that journey remains missing evidence.
