<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# D10 authorization evidence

On dev pushes, the existing D7 evidence job also publishes `d10-evidence/authorization.json`. It lists every POST, PUT, PATCH and DELETE discovered by the access census, including unresolved handlers and operations from OpenAPI. It records Cedar action names enrolled in `ACTION_SCHEMAS` using the existing `Feature` wire names, authorization models, refusal-code test results, and whether a passing test proves refusal with no grant. No new PR gate or test run is added.

```sh
bash scripts/pull-d10-evidence.sh RUN_ID READER_DIR [REPO]
```

The repository comes from the argument or `GITHUB_REPOSITORY`. `READER_DIR` must be the directory containing `evidence.py`; there is no default checkout path. The pull command accepts only dev push artifacts matching the run's commit; the reader checks ancestry, UTC timestamps and shape. The original report times determine freshness, using D7's shared seven-day constant. Neither producer nor pull refreshes old proof.

D10 L2 requires a passing no-grant refusal for every module write. L3 also requires a named Cedar action and Cedar coverage without legacy model references. Missing operations, unknown probes, failed attempts and failed retries cannot raise a score. Each decision cites the artifact commit and time and names uncovered operations. A passing assertion of a common refusal code is listed for review but cannot supply no-grant proof for unrelated endpoints.

The report contract for a live no-grant test is an inline Playwright JSON attachment named `write-probe`, content type `application/json`:

```json
{"operation":"POST /api/v1/example","principal":"no-grant","http_status":403,"control_http_status":422}
```

The test must use an account invited with access `none`, assert refusal, and send an ops-account negative control for the same operation. A control returning 401 or 403 is a harness fault; only 2xx or other 4xx establishes that the probe reaches the operation. A no-grant 2xx is red; 401, validation failures, 404s and missing attachments are unknown. The producer also requires an executed passing test with no failed retries or report errors.

This slice adds the producer and reader. Existing reports contain no live write-probe attachments, so their writes correctly remain unknown. The live probe sweep and self-service exceptions are the next slice; this artifact does not claim those tests already exist. Static resolution follows unambiguous free-function calls using the existing Rust module/import resolver. Trait dispatch, dynamic action selection and standalone action bundles remain unresolved until their resolution has regression proof.
