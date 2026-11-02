<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# D10 authorization evidence

On dev pushes, `d10-probes` runs the live write census on Chromium against the same E2E backend binary built by the backend job. It creates an operating tenant through the product UI and invites an account with access `none`. Each census write receives an empty JSON request from that account and an identical request from the ops account. Fixture IDs cover the legal entity, workplace, department, employee and role; other parameters receive fresh UUIDs. Unresolved paths remain unknown.

The built-in JSON reporter publishes `d10-playwright`, including failed attempts. The existing D7 evidence job consumes it and publishes `d10-evidence/authorization.json`, retaining each operation's HTTP status, refusal code, support reference and ops-control status. The census also retains unresolved handlers and Cedar action names enrolled in `ACTION_SCHEMAS`. No dependency or PR gate is added.

```sh
bash scripts/pull-d10-evidence.sh RUN_ID READER_DIR [REPO]
```

The repository comes from the argument or `GITHUB_REPOSITORY`. `READER_DIR` must be the directory containing `evidence.py`; there is no default checkout path. The pull command accepts only dev push artifacts matching the run's commit; the reader checks ancestry, UTC timestamps and shape. The original report times determine freshness, using D7's shared seven-day constant. Neither producer nor pull refreshes old proof.

D10 L2 requires a passing no-grant refusal for every module write. L3 also requires a named Cedar action and Cedar coverage without legacy model references. Missing operations, unknown probes, failed attempts and failed retries cannot raise a score. Each decision cites the artifact commit and time and names uncovered operations. A passing assertion of a common refusal code is listed for review but cannot supply no-grant proof for unrelated endpoints.

The report contract for a live no-grant test is an inline Playwright JSON attachment named `write-probe`, content type `application/json`:

```json
{"operation":"POST /api/v1/example","principal":"no-grant","http_status":403,"code":"missing_grant","control_http_status":422}
```

The test must use an account invited with access `none`, assert refusal, and send an ops-account negative control for the same operation. Only 2xx or 4xx other than 401/403 establishes a usable control. The sweep requires at least one usable protected-write control. A no-grant 2xx is red and a 401 fails the harness; validation failures, 404s, transport faults, unusable controls, missing codes and missing attachments are unknown. The producer also requires an executed passing test with no failed retries or report errors.

`e2e/authz/self-service.json` names operations that need no role grant, with a reason per entry. They are still attempted and attached, excluded from the sweep's refusal assertion, and cannot supply no-grant proof or raise a module's score. A newly forbidden entry (403) fails the sweep so the catalog shrinks. Static resolution follows unambiguous free-function calls using the existing Rust module/import resolver. Trait dispatch, dynamic action selection and standalone action bundles remain unresolved until their resolution has regression proof.
