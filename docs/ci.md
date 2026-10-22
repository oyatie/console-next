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
| `rust-build` | Format; default, `full` and `full,test-postgres` Clippy; bounded affected target-group archives; one backend binary for every browser shard |
| `backend-test` | Non-DB library tests from their affected group archive, using nextest `slice:` partitions |
| `backend-db` | All remaining tests, including mixed SQLx library tests, from their group archive, with an isolated PostgreSQL service per partition |
| Five personal-data jobs | Existing classification, pii-no-logs, tenant-isolation, rls-arming and audit-coverage gate executables built once by `rust-build` |
| `e2e-plan`, `e2e` | Existing duration bin packing, Chromium and Firefox; clock projects stay serial; first-run-solo is always in browser shard 1 |
| `ci-ok` | Every required job succeeded; skips pass only when `plan` explicitly marked that job unnecessary |

An npm consumer or backend change also needs the web build used by E2E. Every
workspace package with a transitive SQLx dependency runs with a database; all
integration binaries run there too. This conservative split keeps mixed unit/DB
binaries intact. No test is removed by the split. Partitions have independent
services, so cluster-global mutators never share a cluster across jobs.

`scripts/ci/config.json` owns retention, target-group size, partition count, shard
size, disk/cache budgets and the quarantine file. Tests execute without retries.
`test-results.py` compares exact JUnit failure IDs against `scripts/ci/baseline.json`:
known trunk reds are reported without blocking; a new red, runner crash, missing
report or expired/unowned entry blocks. JUnit, baseline counts and traces remain
available for known reds too. `ci-ok` validates expiry independently of test jobs.

The initial baseline records the existing trunk failures from the 2026-10-22
`baseline-reds.v2` receipt and `full-tip-chromium` run in the owner handoff (128
exact browser or nextest IDs, owner Jason Lee, expiry 2026-11-05). It contains no
wildcards. After this initial seed, hygiene compares the PR/queue base's version
and permits only removal: no additional IDs, expiry extension or owner changes.
Remove resolved IDs when their journeys are fixed; the scan and expiry do not
silently turn off. Strict Clippy needs no baseline.

Cargo.lock, toolchain manifests, package manifests/lock, migrations, OpenAPI,
registry, third-party, scripts, ops and workflow changes force full proof. A docs-only
PR runs plan/hygiene/ci-ok. A queue run always runs every proof job.

The reachability gate reads its debt-owner IDs from `registry/reach-units.json`,
seeded from the unchanged cutover baseline. Existing reachability, stale-entry and
shrink-only checks remain. Public proof validates this reviewed registry rather
than the Mac's private queue, which is absent from a GitHub runner.

## Database and browser topology

The repository has one PostgreSQL image pin. `scripts/ci/db-contract.mjs` reads it from
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
`ci-ok` reports repository cache usage and warns when it exceeds the configured
budget. Cache eviction lag does not block product merges. GitHub evicts old entries; cold/warm runs
establish how much of the budget this workspace consumes. The compiler cache key is
stable for toolchain + lock + stripped test profile, with one primary-group writer;
it does not create a new 1 GiB cache entry for every SHA or target group. Docker BuildKit `type=gha`
caching is not wired: the public root has no image build context, and inert CD's
source-rebuild policy is preserved. The CD arm64 job uses `ubuntu-24.04-arm` natively.

Before artifact/cache/summary publication, `privacy.mjs` scans **data-bearing**
upload roots: JUnit, logs, trace ZIPs and their resources, screenshots, metrics,
summaries, built web assets and timing data. The structural scanner and full /
Excel-stripped checksum-identifier checks fail closed without echoing values.
Runner filesystem paths in ordinary JUnit XML are diagnostics; local office-path
rules apply only inside OOXML packages. Office XML, nested archives, unknown
binary payloads, symlinks and private-term controls retain refusal tests. Raster
media follows the existing scanner: names are checked; pixels are not OCRed.

Compiler output, nextest archives and backend/gate executables built from the
scanned public source are **not data-bearing uploads**. They and sccache/Cargo
build caches are outside the tenant-data scan roots; the scanner has no blanket
ELF/Mach-O or sccache exemption when a binary appears in a diagnostic upload.
This avoids interpreting upstream author credits and machine code as tenant data.
Public dependency tarballs in data-bearing cache roots must match lockfile hashes;
modified or unproven Cargo/npm payloads are refused. Browser cache files must match
the SHA-256 inventory captured before tests. This never exempts traces or screenshots.

`check-fixture-ids.mjs` owns the shared synthetic generators/ranges. The structural
scanner reads the same `fixture-synthetic-ranges.json`; E2E phone generators use
its placeholder middle group and RRN generators deliberately fail the check digit
(and the CRN checksum). The 3,000-row generator regression proves uniqueness and
scan acceptance. A real-shaped non-placeholder phone and a checksum-valid RRN,
including its stripped form, are still refused in JUnit and trace ZIP controls.

The optional `CONSOLE_CLIENT_DATA_TERMS` secret is passed only into trusted
`push: dev` / `merge_group` privacy steps. The wrapper creates a mode-600 temporary
file for the scan, checks both tracked source and upload data, and deletes the
file in `finally`. Product tests and build steps receive neither the secret nor
a persistent file/environment reference. Plain PRs run the structural checks.

JUnit is uploaded after every test run that passes privacy scanning; traces are
uploaded only on failure. Retention comes from config (currently seven days).
Passing shards publish measured duration records for the next trusted run. Every
CI job records elapsed seconds and cache lookup/hit counts; scanned summaries
show these without source or fixture text. `ci-ok` additionally reports repository
cache bytes. Uploads are withheld if the plan has no configured retention; they never fall
back to repository defaults. Missing or malformed reports remain errors. A built Rust group with no test
cases may report an explicit zero-test JUnit only after a successful nextest run;
an empty browser report is always refused.

## Hosted disk bound

A clean build uses `debug=0`, `strip=debuginfo`, no incremental output and bounded
sccache. The metadata plan partitions **test targets**, rather than building all
120 app binaries on one runner. Each target belongs to one mode/group; library
binaries with a transitive SQLx dependency stay in DB groups. Six targets per
group currently produces 123 build groups (734 test binaries), 106 DB partitions
and 17 non-DB partitions. Archives contain only that group's selected binaries;
`--partition slice:1/1` runs its partition. Package-owned `full` / `test-postgres`
features are enabled only for selected packages. The backend binary and five gate
executables are built once, in the primary group. Source hygiene must pass first.

Measured 2026-10-22 on **macOS arm64**, Rust 1.98.1, with a fresh target directory:

| Shape | Build bytes (GiB) | Compressed archive (GiB) | Test job incl. extraction (GiB) |
| --- | ---: | ---: | ---: |
| Primary: strict Clippy x3, app group, five gates, E2E backend | 8.715 | 0.334 | 2.146 |
| Six app integration targets, conservatively retaining primary metadata/gates/backend | 9.142 | 0.461 | 2.952 |

Build bytes include the target, artifacts, tracked checkout, resolved dependency
sources and a full 1 GiB compiler-cache reserve. No decoded archive is materialized
for scanning or rewriting. `disk-budget.py` streams tar inventories and refuses
more than 10 GiB of produced build/test data or less than 3 GiB free space before
publication. The measured maximum plus the 3 GiB margin is 12.142 GiB, below the
standard runner's 14 GB disk allowance reported by the verifier. The source/cache
reserve and unused primary outputs make the integration receipt conservative.

**Linux amd64 is not measured locally.** Its cold/warm hosted jobs must retain the
numeric disk receipt and pass the same limits; architecture parity is not assumed.
The verifier must confirm actual free disk before/after the largest amd64 job.
The previous whole-workspace 49 GB extraction / 72 GB target is no longer a job.

## Repository file policy

`npm run check` starts with `node scripts/check-repo-files.mjs`: it checks committed
paths changed from the merge base with the PR's `origin/$GITHUB_BASE_REF`, or `dev`
locally. Pass another base ref explicitly when needed. Hygiene always runs
`node scripts/check-repo-files.mjs --full`, including on docs-only changes and
merge groups, so the required `ci-ok` covers the whole committed tree.

`scripts/repo-files.policy.json` owns the restricted paths, file patterns, exact
exceptions and 5,000,000-byte maximum. Failures name the path and rule. Deploy
files remain allowed; spreadsheet exceptions do not exempt other document types
or the size limit. Round 3 relocated the curated topology files to `e2e/stack/`
and `scripts/ci/`; the policy names each file, and its `ops/**` allow-list is empty.
All three named files passed structural client-data scanning and gitleaks again.
The Node regression suite has refused and allowed controls for every rule.

After this lane merges, the orchestrator updates `dev-pr-only` (25624651) to
require `ci-ok` in place of `backend` and `web`, enables the merge queue, and deletes
the disabled, unsupported public-source push ruleset `push-restrictions` (25552233).

## Reading a red and rerunning

Open `ci-ok` first. A red dependency or a dependency-caused skip is a failed proof.
Open that job, then its scanned JUnit and `.baseline.json` artifacts. Known baseline
failures stay visible in those reports and the job/totals summaries. A privacy red means the payload
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
its failing-job logs. Verifier round 3 retrieved run 39613833016: check-reach
expected the private orchestra queue on the hosted runner. CI-0 owns the fix and
its regression; this branch is based on `ci/ci-0-hermetic` and carries no duplicate
check-reach or reach-registry edits.

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
The round-3 verifier rejected compiled archives and failure diagnostics under
that earlier scan policy. The data-bearing scope and fixture fixes above replace
those round-2 upload assumptions. Workflow/actionlint, allowed SHA pins, ShellCheck, touched-script
lint and Compose render pass. Curated stack/scanner gitleaks and structural scans
have zero findings. At round 2 the structural source differed from infra only by SPDX; round 3
shares its synthetic ranges with the fixture checker.
No GitHub API mutation, push, ruleset application, hosted browser run or live
production inspection was performed. Hosted cold/warm/docs-only/crate evidence
and one executed shard per browser remain verifier work.

## Round 3 verification receipt

The lane is based on CI-0 (`4cbc2e76`); check-reach and its registry have no CI-1
diff. Added 24 CI regression tests. On unchanged `7bf10b0e` the candidate suite has
25 of 47 tests red; all 47 pass on the candidate. The complete npm check
has 63 Node tests and 218 Vitest files / 1,159 tests. Mutation controls kill all
19 tested removals/bypasses, including needed-job skips, final enforcement,
Clippy, the five-gate command path, DB/E2E commands, hygiene and wrong-browser /
library-only archives. The frontend-only planner regression also fails before its
fix and passes after it; unsupported future Cargo test kinds refuse planning.

Rust format, all three strict Clippy sets and workspace test checking pass.
`cargo test --lib --workspace`: 196 targets, 2,009 pass, one existing ignore.
The two touched DB crates pass 220 tests against the lane database, including
both executed Docker census cases. A fresh service using the repository digest
passes the exact prepare/bootstrap/archive/partition path: 52 tests in two DB
suites; the post-migration bootstrap examines all 20 canonical tables. A separate
multi-crate non-DB archive passes 98 tests. All five personal-data gates pass.

Actionlint, YAML/action pins, ShellCheck, fixture identifiers, structural scans,
gitleaks and touched-script lint pass. Scan controls include clean failing JUnit
and trace ZIPs with runner paths/synthetic data, planted real-shaped phones and
valid full/stripped RRNs, symlinks, corrupt dependency cache hashes, nested archives
and trusted private terms. The actual web build, DB JUnit and unit JUnit are also
scanned. The verifier's saved failing `person` trace also passes (359 ZIP members),
including its network resources and screenshots. No excluded lane file is changed.
All new source headers pass.

Remaining verifier proof is the merge result in Actions: one actual shard per
browser, cold/warm/docs-only/one-crate runs, actual amd64 disk/cache measurements,
and the owner-applied ruleset. No push, GitHub API call, ruleset application, live
production inspection or sandbox browser run was performed. Probe additionally
requires the existing workflow input secret `CONSOLE_PUBLIC_HOST`; Telegram uses
`CONSOLE_TELEGRAM_BOT_TOKEN` / `CONSOLE_TELEGRAM_CHAT_ID`. CD remains opt-in and inert.

## Files outside the initial owns list

These support the workflow and its required proof (including the explicitly
requested round-2 test topology/scanner). No excluded lane file was touched:

- `.client-data-allow`, `.config/nextest.toml`
- `.github/workflows/workflows-check.yml`
- `e2e/stack/compose.yml`, `e2e/stack/otel-collector.yml`
- `package.json`, `playwright.config.ts`, `vitest.config.ts`
- `scripts/backend-dev.mjs`, `scripts/client-data-scan.py`
- `scripts/cd-workflow.test.mjs`
- `scripts/ci.test.mjs`, `scripts/ci-privacy.test.mjs`, `scripts/ci-results.test.mjs`
- `scripts/check-fixture-ids.mjs`, `scripts/check-fixture-ids.d.mts`, `scripts/fixture-synthetic-ranges.json`
- `e2e/helpers/import.ts`, `e2e/helpers/import-layouts.ts`, `e2e/access-parity.spec.ts`
- `e2e/parity/e3.ts`, `e2e/people-actions/register-run.spec.ts`
- `scripts/ci/baseline.json`, `scripts/ci/test-results.py`, `scripts/ci/disk-budget.py`, `scripts/ci/rust-build.mjs`
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
