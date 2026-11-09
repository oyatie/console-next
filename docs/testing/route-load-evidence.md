<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Route-load evidence

The `route-load` workflow runs the existing `e2e/perf/route-load.spec.ts` nightly and through manual dispatch. It has its own concurrency group, so the long lab run cannot delay nightly or manually dispatched live E2E. Its `route-load` job reuses the served application artifact and the pinned PostgreSQL service. It builds a synthetic tenant through product controls: the shape and LCP objective come from `backend/app/slos/page-load.openslo.yaml`; sample count and deadline come from `e2e/perf/lab.yaml`. Routes come from the router's shared route list. No mock timing can raise D6.

The job uploads `route-load-evidence/route-load.json` even when measurements fail. It keeps the checked-out `commit`, original UTC `run_at`, `source_command`, raw samples and cold/warm rows. Complete rows fail when p95, the SLO compliance target or the existing duplicate-read guard fails. Incomplete measurements retain `unknown` and null LCP; neither missing nor unknown data supplies green. A held-read control must exceed the objective and be rejected before real routes are measured. Setup failures may leave no rows; an empty artifact supplies no route coverage.

Download from a trusted dev run of **route-load**, then ingest with the existing reader. `REPO` is the GitHub repository, `RUN_ID` is its run ID, `ARTIFACT_DIR` is an empty directory outside the checkout, and `READER_DIR` contains `evidence.py`. Verify the artifact commit equals the run's `headSha` before ingesting; ingest independently checks dev ancestry, UTC timestamps and the envelope. Never change an old artifact's commit or time to refresh it.

```sh
gh run view "$RUN_ID" --repo "$REPO" --json event,headBranch,headSha
gh run download "$RUN_ID" --repo "$REPO" --name route-load-evidence --dir "$ARTIFACT_DIR"
python3 -m json.tool "$ARTIFACT_DIR/route-load.json"
CONSOLE_NEXT="$PWD" python3 "$READER_DIR/evidence.py" ingest "$ARTIFACT_DIR/route-load.json"
CONSOLE_NEXT="$PWD" SCREENS_REF=public/dev python3 "$READER_DIR/build.py" inventories
CONSOLE_NEXT="$PWD" SCREENS_REF=public/dev python3 "$READER_DIR/build.py" check
```

The reader must support null LCP for unknown rows. Evidence older than seven days remains pending; a fresh failing route names its path and cache state. Current D6 evidence covers lab loads, not burst capacity or field telemetry. The duplicate-read collector detects overlapping identical reads, not every possible N+1 query.

## Existing producers

`ci` publishes `d7-evidence` (`e2e.json`, `nextest.json`), `d10-evidence` (`authorization.json`) and `d8-evidence` (`states.json`, `write-probe.json`, `e2e.json`). The D10 normalizer consumes `scripts/d10-census.mjs`; it does not publish a separate census envelope. Use the existing D7/D10 pull commands for those sources.

Support-reference observations already cover failed, refused and no-reference cases per route, including observed and declared floorplans. To ingest those existing states without rerunning the browser, download `d8-evidence` from a trusted **ci** dev push, verify its commit as above, and ingest its `states.json` with the same command. These observations do not establish loading or empty coverage. D8 additionally needs the live refused-write reference lookup and client-error beacon evidence; a states artifact alone cannot raise it.
