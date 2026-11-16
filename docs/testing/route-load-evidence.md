<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# Route-load evidence

The `route-load` workflow runs the existing `e2e/perf/route-load.spec.ts` nightly and through manual dispatch. It has its own concurrency group, so the long lab run cannot delay nightly or manually dispatched live E2E. Its `route-load` job reuses the served application artifact and the pinned PostgreSQL service. It builds a synthetic tenant through product controls: the shape and LCP objective come from `backend/app/slos/page-load.openslo.yaml`; sample count and deadline come from `e2e/perf/lab.yaml`. Routes come from the router's shared route list. No mock timing can raise D6.

The job uploads `route-load-evidence/route-load.json` even when measurements fail. It keeps the checked-out `commit`, original UTC `run_at`, `source_command`, raw samples and cold/warm rows. Complete rows fail when p95, the SLO compliance target or the existing duplicate-read guard fails. Incomplete measurements retain `unknown` and null LCP; neither missing nor unknown data supplies green. A held-read control must exceed the objective and be rejected before real routes are measured. Setup failures may leave no rows; an empty artifact supplies no route coverage.

Production terminates TLS at the Cloudflare edge, which serves HTTP/2 and has HTTP/3 enabled, and reaches the origin through a cloudflared tunnel. The edge configuration is kept outside this repository. The perf profile uses Node's HTTP/2 TLS server to reproduce multiplexed browser delivery, with an OpenSSL-generated throwaway localhost certificate. It deletes the certificate files immediately after reading them and limits certificate trust to the perf project. It does not reproduce edge caching or HTTP/3 transport.

Each route is measured through the same HTTPS proxy origin in the same run, using the same saved synthetic tenant, fresh browser contexts and unchanged budget, sample count and deadline. The HTTP/1.1 browser disables HTTP/2 negotiation (Chromium `--disable-http2`; Firefox `network.http.http2.enabled=false`). Both legs retain the same cookies, refresh origin and TLS settings. Only production HTTP/2 rows gate the budget and appear in `rows`; HTTP/1.1 rows remain in `comparison` for reporting. The evidence reader consumes only `rows` and rejects explicitly non-h2 production rows.

Rows carry `protocol`; cold samples must negotiate that protocol. Warm navigations may come from the browser cache without a negotiated protocol. Each sample retains its resource count, maximum request queue and last response end. Full navigation/resource waterfalls (start, request start, response start, end and transferred bytes) are retained only for failed samples. The workflow summary contains both cold p95 values per route and their p95 sample's waterfall summaries for inclusion in the PR.

Local correctness is checked by `authenticated-transports.spec.ts`: both legs must refresh real authentication and produce complete cold/warm rows. Its small fixture proves transport correctness, not the synthetic-tenant budget. Use the hosted `route-load` run on the PR branch for paired p95 evidence; local timings under contention are not performance proof.

Run the same profile locally with the existing backend launcher and an evidence directory outside the checkout:

```sh
E2E_SERVED=1 E2E_PERF=1 PERF_EVIDENCE_DIR="$ARTIFACT_DIR" \
  npx playwright test --config=playwright.perf.config.ts --project=parallel --retries=0
node e2e/perf/report.ts "$ARTIFACT_DIR/route-load.json"
```

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
