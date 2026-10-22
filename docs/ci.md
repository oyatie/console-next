<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# GitHub Actions proof

`ci-ok` is the single required check for `dev`. Pull requests get affected proof;
`merge_group` proves the full merge result before the merge queue can admit it.
Local checks are useful feedback. Their results never replace the queue check.
Forks use plain `pull_request`, a read-only token and no secrets. There is no
`pull_request_target` path. Superseded PR runs are cancelled; queue runs finish.

## What runs where

| Job | Proof |
| --- | --- |
| `plan` | Cargo workspace members and reverse path dependencies, npm workspaces and reverse consumers; unknown/shared inputs force full proof |
| `hygiene` | Workflow safety regression tests, actionlint, fixture identifiers, structural client-data scan and gitleaks |
| `web` | Existing `npm run check`: contracts, TypeScript, lint, Vitest, production build, bundle budget, secret/licence/fixture checks |
| `rust-build` | Format; default, `full` and `full,test-postgres` Clippy; one workspace nextest archive; one backend binary for every browser shard |
| `backend-test` | Non-DB library tests from the archive, split with nextest `slice:` partitions |
| `backend-db` | All remaining tests, including every SQLx suite, from that archive, against an isolated PostgreSQL service per partition |
| Five personal-data jobs | Existing classification, pii-no-logs, tenant-isolation, rls-arming and audit-coverage gate executables built once by `rust-build` |
| `e2e-plan`, `e2e` | Existing duration bin packing, Chromium and Firefox; clock projects stay serial; first-run-solo is always in browser shard 1 |
| `ci-ok` | Every required job succeeded; skips pass only when `plan` explicitly marked that job unnecessary |

An npm consumer or backend change also needs the web build used by E2E. Every
workspace package with a transitive SQLx dependency runs with a database; all
integration binaries run there too. This conservative split keeps mixed unit/DB
binaries intact. No test is removed by the split. Partitions have independent
services, so cluster-global mutators never share a cluster across jobs.

`scripts/ci/config.json` owns retention, partition count, shard target, cache budget
and quarantine metadata. Tests are not retried. The quarantine list starts empty;
entries must name a test, owner and future expiry. An entry alone does not exclude
a failing test. Changing a test's execution policy requires a reviewed config change.

Cargo.lock, toolchain manifests, package manifests/lock, migrations, OpenAPI,
registry, third-party, scripts, ops and workflow changes force full proof. A docs-only
PR runs plan/hygiene/ci-ok. A queue run always runs every proof job.

The reachability gate reads its debt-owner IDs from `registry/reach-units.json`,
seeded from the unchanged cutover baseline. Existing reachability, stale-entry and
shrink-only checks remain. Public proof validates this reviewed registry rather
than the Mac's private queue, which is absent from a GitHub runner.

## Database and browser topology

The production Compose source and existing census harness use the same PostgreSQL
pin. `scripts/ci/db-contract.mjs` reads it from
`backend/ci/gates/writer-ownership/tests/census_executes_against_postgres.rs`;
plan outputs feed the hosted DB services, and the local/browser launcher uses the
same reader. No Compose/YAML file duplicates the digest.

The registry retry on 2026-10-22 returned this exact Docker CLI error:
`manifest verification failed for digest sha256:65f70a152846cf504dff86e807007e9aeac98c3aeb7b62541b2c55ab9d264e56`.
An independent anonymous Docker Hub Registry v2 request returned HTTP 200; both
`Docker-Content-Digest` and the SHA-256 of the response body matched the requested
pin. Registry access and digest integrity are verified. The subsequent Colima
`docker pull` also succeeded with the requested digest (`Image is up to date`).
This retry was not blocked by sandbox networking or DNS. A fresh amd64 hosted
service pull remains verifier proof.
This receipt does not claim an inspection of the live production deployment.

Curated public test files (no production addresses, names, secrets, external
networks, proxy, app-image builds, workers, WAL backup or deployment services):

| File | Purpose | Evidence |
| --- | --- | --- |
| `e2e/stack/compose.yml` | PostgreSQL, topology one-shot, SeaweedFS, OTEL and Mailpit, curated from the existing three Compose files | Compose render; structural scan and gitleaks: zero findings |
| `e2e/stack/otel-collector.yml` | Existing OTLP pipeline with basic counts; request/fixture attributes are not logged | Same scans; Compose render |
| `scripts/ci/postgres-reconcile-topology.sh` | Existing eight-role bootstrap and verification, relocated unchanged | Exact shared command against the pinned lane service; post-migration census enforces all 20 canonical tables; two DB suites pass |
| `.github/rulesets/dev.json` | Owner-applied branch rules | JSON/workflow property tests |

Only loopback port bindings and Compose-local service discovery appear in the
test stack. The backend, E2E fixtures and tests keep using the existing ignored credential/key
location through the same helper, preserving existing development vault keys.
There are no CI additions under the push-restricted directories. Runtime readers
and current module documentation use the new source path. Applied migration
comments retain their historical paths to preserve SQLx migration checksums.

`scripts/ci/bootstrap-db.sh CONTAINER ENV_FILE` is the exact bootstrap command for
both local proof and the hosted service. `prepare-db.mjs` creates fresh credentials,
masks them and exports the test URLs without printing fixture/request contents.
The dedicated SQLx admin role and startup marker are derived from migration 0196;
connections carry its explicit test marker, preserving the production refusal.

## Caches, artifacts and public data

Only SHA-pinned `actions/*` and `step-security/harden-runner` actions are used.
Harden-runner blocks egress outside each job's explicit allow-list. Tools are
checksum-verified release archives from `scripts/ci/versions.json`, including
nextest, cargo-deny and sccache. The tool archives were downloaded and hashed
locally; no third-party installation action is involved.

`actions/cache/restore` reads Cargo registry/git data keyed on Cargo.lock, sccache
keyed on toolchain/lock/test profile (falling back to the toolchain), npm keyed on
package-lock, Playwright keyed on its resolved package version, and passing E2E
duration records. Only successful `push: dev` jobs can save; PRs and merge groups
never save. `setup-node` has no implicit cache writer. sccache is bounded by config.
`ci-ok` reads repository cache usage and fails when it exceeds the configured
budget. GitHub evicts old entries; the owner must monitor usage as cold/warm runs
establish how much of the budget this workspace consumes. Docker BuildKit `type=gha`
caching is not wired: the public root has no image build context, and inert CD's
source-rebuild policy is preserved. The CD arm64 job uses `ubuntu-24.04-arm` natively.

Before **any** artifact/cache/summary upload, `privacy.mjs` invokes
`scripts/ci/scan-uploads.py`, which imports the curated structural scanner and
checks the explicit upload roots, file/member names and checksum-valid identifiers,
including Excel's stripped-leading-zero form. ZIP, gzip, tar and zstd contents are
read recursively without extracting archive paths onto the runner. Executables
are checked as UTF-8/UTF-16 strings. Browser distributions use a SHA-256 inventory
recorded immediately after the locked Playwright installer, before product tests:
only unchanged downloaded bytes can enter the browser cache. Added/changed files
fail the scan. This keeps public browser credits, locale packs and snapshots out
of application-data classification; it does not exempt test traces or screenshots. Unknown binary formats, symlinks, bad archives,
scanner errors or findings fail closed; output contains only counts and refusal
categories. Raster media follows the existing scanner's policy: names are checked,
pixels are not OCRed. Generated credentials and application state are never upload
roots.

`scripts/client-data-scan.py` is the existing infra implementation with only an
SPDX header added. It has structural rules and no client-specific list. Its source
passes gitleaks and the identifier grep. `.client-data-allow` records reviewed
synthetic 000-prefix controls, exact fuzz seeds and hashed public upstream credits;
it contains no client identifiers. Public dependency tarballs are accepted only
when their bytes match the current Cargo/npm lockfile checksum. Dependency caches
restore by exact lockfile key, keeping unrelated older packages out of scan roots.
Browser keys additionally include the browser, so a Chromium save cannot prevent
Firefox from having a warm cache. The verified Chrome-for-Testing redirect to
`storage.googleapis.com` is included in the egress allow-list.
Nextest metadata has unused upstream author contacts removed before sharing;
its binaries and other metadata are preserved and still scanned.

If the owner supplies private client-name rules, store newline-separated terms in
the optional `CONSOLE_CLIENT_DATA_TERMS` repository secret. Only `push: dev` and
`merge_group` materialize it into a mode-600 file in `RUNNER_TEMP`, exposed to the
scanner through `CONSOLE_CLIENT_DATA_TERMS_FILE`. A separate trusted tree check
uses that same file. No list, private term or secret value is committed or printed;
plain PRs, including forks, receive no secret file and run structural checks.
Planted controls cover clean/refused text, UTF-16, ZIP, gzip/tar, zstd, full/stripped
RRNs, BRN checksums and the private-term file. These controls run in hygiene and
`npm run check`.

JUnit is uploaded after every test run that passes privacy scanning; traces are
uploaded only on failure. Retention comes from config (currently seven days).
Passing shards publish measured duration records for the next trusted run. Every
CI job records elapsed seconds and cache lookup/hit counts; scanned summaries
show these without source or fixture text. `ci-ok` additionally reports repository
cache bytes. Empty/missing test reports remain errors, never successful evidence.

## Reading a red and rerunning

Open `ci-ok` first. A red dependency or a dependency-caused skip is a failed proof.
Open that job, then its scanned JUnit artifact. A privacy red means the payload
was withheld: reproduce locally; do not print findings into the public job log.
For E2E, download the failing shard's trace only after its scan passed and open it
with `npx playwright show-trace`. Use the matrix's browser/project/files to reproduce
the same shard. An empty timing cache uses the existing planner's conservative
fallback estimates; it is not evidence of measured cold-run durations.

Clippy is strict for all three feature sets. The unchanged cutover base passed
default, `full`, and `full,test-postgres` with zero diagnostics on this lane; no
red baseline or lint exception was needed. Every set keeps `-D warnings`.

Use the run's **Re-run failed jobs** for transient runner/network failures, or
**Re-run all jobs** when validating shared artifacts and a complete queue result.
If GitHub expires/rebuilds a merge group, re-enqueue the PR so the new merge SHA
gets its own full proof. Never substitute local receipts or a previous SHA's green.

## Owner applies the dev ruleset

These commands are instructions only; this lane does not call the GitHub API or
push. Run from the repository checkout with the owner's administrative `gh` login:

```sh
repo=oyatie/console-next
gh api "repos/$repo/rulesets" --jq '.[] | {id,name,enforcement}'
ruleset_id="$(gh api "repos/$repo/rulesets" --jq '.[] | select(.name == "dev-protected") | .id')"
if [ -n "$ruleset_id" ]; then
  gh api --method PUT "repos/$repo/rulesets/$ruleset_id" --input .github/rulesets/dev.json
else
  gh api --method POST "repos/$repo/rulesets" --input .github/rulesets/dev.json
fi
gh api "repos/$repo/rulesets" --jq '.[] | select(.name == "dev-protected") | .id' |
  while read -r id; do gh api "repos/$repo/rulesets/$id"; done
```

The JSON requires PRs with **zero** approvals, the merge queue, GitHub Actions'
`ci-ok` context, resolved conversations, and blocks deletion/force push. Its empty
bypass list applies to administrators too. Check other active org/repo rulesets
for conflicting approval/direct-push rules before applying. Do not change Actions
permissions, enable CD, or add an administrative check bypass to make a red pass.

## Post-flip proof receipt

The old `ci` push failure at 2026-10-21T14:06:01Z is recorded in the handoff without
its failing-job logs. Its cause cannot be diagnosed from that conclusion alone;
the owner/verifier must retrieve its jobs/logs before claiming G-46 closed.

No hosted run is fabricated. Fill this table from Actions job durations, scanned
cache counters and repository cache usage from the hosted runs:

| Run | Before minutes | After minutes | Cache hit % | Total cache bytes | Evidence |
| --- | --- | --- | --- | --- | --- |
| Cold full merge group | Unmeasured | Pending | Pending | Pending | Actions run URL + merge SHA |
| Warm full merge group | Unmeasured | Pending | Pending | Pending | Actions run URL + merge SHA |
| Docs-only PR | Unmeasured | Pending | Pending | Pending | plan + hygiene + ci-ok, proof jobs intentionally skipped |
| One crate PR | Unmeasured | Pending | Pending | Pending | planned reverse dependencies + nextest selected packages + ci-ok |

Verifier: run one generated shard per browser using the curated test topology;
run two DB suites through the shared bootstrap/archive commands; confirm every SQLx
suite appears in the DB inventory; exercise a failed rust-build whose dependent
tests skip and verify ci-ok is red; then run the full merge group, inspect JUnit,
traces, privacy controls, cache writes/size and required-check enforcement. The
merge result in GitHub Actions is the final proof.

## Hosted verifier sequence

1. Exercise a cold full merge group with no matching trusted caches. Record the
   merge SHA, run URL, every job's duration, hit counts and total cache bytes from
   `ci-ok`. Check every SQLx suite is present in the DB inventory and both browsers
   report JUnit. Deliberately fail a build and confirm dependent skips make `ci-ok`
   fail. Inspect a failed browser shard's scanned trace artifact.
2. After the successful queue result lands, the `push: dev` run seeds trusted
   caches. Run another full merge group with unchanged locks/toolchain for the
   warm comparison. Re-running a PR or merge group alone cannot warm caches:
   those events restore only. Confirm total repository cache bytes remain below
   `cacheBudgetBytes`; all artifacts use `retentionDays`.
3. Open a docs-only PR: only plan, hygiene and the always-reporting `ci-ok` run.
   Then use a leaf Cargo gate crate change to show the affected crate selection,
   skipped web/E2E jobs and a reporting `ci-ok`. Queueing either PR must force
   the full proof on the merge SHA.
4. Reproduce `e2e-plan` locally, preserving its `E2E_TIMINGS_FILE` when available;
   set `SHARD` to one emitted matrix entry per browser, then run
   `node scripts/ci/e2e.mjs run` with the workflow's prebuilt artifacts/environment.
   Confirm first-run-solo is in shard 1 for each browser. Run the two DB suites
   through the shared bootstrap and archive runner. Each partition needs a fresh
   extraction directory (hosted jobs are isolated).
5. Plant refusal controls in actual JUnit/trace/cache/upload payloads and confirm
   the job fails with no artifact, cache save or summary publication. Confirm fork
   PRs receive no private-term secret, and only successful dev pushes save caches.
   Apply and read back the ruleset with the owner commands above; prove direct
   pushes/force pushes/deletion and unproved queue entries cannot reach `dev`.

Use Actions run/job logs and the scanned `metrics-*` artifacts to fill the table;
never replace these measurements with local timings. For owner/verifier readback:

```sh
gh run list --workflow ci.yml --json databaseId,event,headSha,conclusion,url
gh run view RUN_ID --json jobs,headSha,event,conclusion,url
gh api "repos/$repo/actions/cache/usage"
```

## Local verification receipt

Round 1 is preserved: full npm check (218 Vitest files, 1,158 tests), 33 Node
safety tests, 196 Rust library targets / 2,009 passing tests / one existing ignore,
workspace check, all three strict Clippy sets, five personal-data gates and two
DB suites passed. The original 20 fail-before tests and reachability regression
remain recorded in the lane receipt.

Round 2 starts from `add66be1`. Regression tests fail on that unchanged worktree
under the lane directory: 8 of 23 focused Node regressions fail on the unchanged
`add66be1` base. The executed-bootstrap regression separately fails before the
post-migration wiring with an explicit zero-table census, then passes after it.
Final checks pass: 39 Node tests; 218 Vitest files / 1,158 tests; 196 Rust library
targets / 2,009 passing tests / one existing ignore; writer-ownership 87 tests;
canonical adapter 133 tests across 11 targets; and all three strict Clippy feature
sets, workspace check and format. The two shared archive DB suites pass three
tests across four partitions. The browser download/cache proof checks 643 public
distribution files without executing a browser; Chromium/Firefox shard plans are
9/8 with first-run-solo in shard 1 for both. The shared relocated bootstrap reconciles all eight roles and enforces 20 canonical tables after migrations;
site_unit and workplace_kind pass three tests across four archive partitions.
The sanitized archive, its metadata, the built web output and sampled compiler
cache formats pass the actual upload scanner. Workflow/actionlint, allowed SHA pins, ShellCheck, touched-script
lint and Compose render pass. Curated stack/scanner gitleaks and structural scans
have zero findings. The structural source differs from infra only by SPDX.
No GitHub API mutation, push, ruleset application, hosted browser run or live
production inspection was performed. Hosted cold/warm/docs-only/crate evidence
and one executed shard per browser remain verifier work.

## Files outside the initial owns list

These support the workflow and its required proof (including the explicitly
requested round-2 test topology/scanner). No excluded lane file was touched:

- `.client-data-allow`, `.config/nextest.toml`
- `.github/workflows/workflows-check.yml`
- `e2e/stack/compose.yml`, `e2e/stack/otel-collector.yml`
- `package.json`, `playwright.config.ts`, `vitest.config.ts`
- `registry/reach-units.json`
- `scripts/backend-dev.mjs`, `scripts/client-data-scan.py`
- `scripts/cd-workflow.test.mjs`, `scripts/check-reach.mjs`, `scripts/check-reach.test.ts`
- `scripts/ci.test.mjs`, `scripts/ci-privacy.test.mjs`
- `scripts/ci/bootstrap-db.sh`, `scripts/ci/postgres-reconcile-topology.sh`
- `scripts/ci/config.json`, `scripts/ci/versions.json`, `scripts/ci/db-contract.mjs`
- `scripts/ci/e2e.mjs`, `scripts/ci/plan.mjs`, `scripts/ci/gate.mjs`
- `scripts/ci/install-tools.sh`, `scripts/ci/notify-telegram.sh`, `scripts/ci/prepare-db.mjs`
- `scripts/ci/privacy.mjs`, `scripts/ci/scan-uploads.py`, `scripts/ci/sanitize-nextest.py`
- `scripts/ci/public-browser-cache.py`
- `scripts/ci/report.mjs`, `scripts/ci/rust-tests.mjs`

Relocation also updates these Rust-side readers/documentation outside the initial owns:

- `backend/ci/gates/writer-ownership/canonical-enforce.sh`
- `backend/ci/gates/writer-ownership/tests/census_executes_against_postgres.rs`
- `backend/ci/gates/writer-ownership/tests/gate_detects_violation.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/company.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/job_position.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/org_unit.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/person.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/company_port_as_runtime_role.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/employment_port_as_runtime_role.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/person_port_as_runtime_role.rs`
