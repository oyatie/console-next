<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# GitHub Actions proof

`ci-ok` is the single required check for `dev`. Pull requests get affected proof;
`merge_group` proves the affected merge result once per queue group. Dispatch `ci.yml`
once for each release unit (the merged batch selected for release) for full proof.
Local checks are useful feedback. Their results never replace the queue check.
Forks use plain `pull_request`, a read-only token and no secrets. There is no
`pull_request_target` path. Superseded PR runs are cancelled; queue runs finish.

## What runs where

| Job | Proof |
| --- | --- |
| `plan` | Cargo workspace members and reverse path dependencies, npm workspaces and reverse consumers; unknown/shared inputs force full proof |
| `hygiene` | Workflow safety regression tests, actionlint, fixture identifiers, structural client-data scan and gitleaks |
| `web` | Existing `npm run check`: contracts, TypeScript, lint, Vitest, production build, bundle budget, secret/licence/fixture checks |
| `rust-build` | Format; default, `full` and `full,test-postgres` Clippy; one affected-workspace test archive per architecture; one backend binary for every browser shard |
| `backend-test` | Non-DB library tests from the shared archive, using nextest `slice:` partitions |
| `backend-db` | All remaining tests, including mixed SQLx library tests, from the shared archive, with an isolated PostgreSQL service per partition |
| Five personal-data jobs | Existing classification, pii-no-logs, tenant-isolation, rls-arming and audit-coverage gate executables built once by `rust-build` |
| `e2e-plan`, `e2e` | Existing duration bin packing; fast Chromium smoke/changed specs, full Chromium and Firefox per release unit; clock projects stay serial; first-run-solo is always in browser shard 1 |
| `ci-ok` | Every required job succeeded; skips pass only when `plan` explicitly marked that job unnecessary |

An npm consumer or backend change also needs the web build used by E2E. Every
workspace package with a transitive SQLx dependency runs with a database; all
integration binaries run there too. This conservative split keeps mixed unit/DB
binaries intact. No test is removed by the split. Partitions have independent
services, so cluster-global mutators never share a cluster across jobs.

`scripts/ci/config.json` owns retention, partition counts, plan job/minute ceilings, shard
size, disk/cache budgets and the quarantine file. Tests execute without retries.
`test-results.py` compares exact JUnit failure IDs against `scripts/ci/baseline.json`:
deterministic trunk reds are reported while they still fail. A deterministic pass
blocks with “fixed: remove from baseline”; a deleted test blocks in the nextest
or Playwright inventory. Unrelated partitions do not count as fixes. A new red,
runner crash, missing report or expired/unowned entry blocks. No retry hides a red.

Entries have `class: deterministic | flaky`. Flaky entries accept either result,
but require at least two distinct `evidence` receipts with `runId`, ISO `date` and
`result: passed | failed`, including both outcomes. Their expiry is at most seven
days after the latest receipt, versus a maximum 14-day deterministic renewal.
The flake budget is seven entries (10% of the 70 remaining IDs); hygiene enforces
it and scanned job summaries show usage and D-7 expiry warnings.

Hygiene compares the PR/queue base: no new IDs or ownership changes; strict IDs
can only shrink. An existing deterministic ID may become flaky only with the
above evidence and short expiry. Receipts are append-only. Extending an expiry
requires a new run ID dated today (a failing run for deterministic entries), at
most 14 days per change, and never more than the class's window from today.
Simply changing the date or replaying an old receipt fails. Removing resolved
entries and shortening expiry are allowed. First-run-solo cannot be quarantined.

The 2026-10-22 `baseline-reds.v2` and `full-tip-chromium` receipts seeded the
baseline. Round 6 removes all 38 DB IDs (38/38 passed through the pinned CI
archive/bootstrap path in verifier round 5), Chromium BL-016 and Chromium BL-013
solo rail (both passed in that verifier run). The remaining 70 browser IDs retain
their failure receipts; there are zero flaky entries until disagreement is proven.
Expiries are grouped by browser/journey across October 30–November 5, earlier than
the original blanket November 5 expiry. Hosted passing IDs must be removed too.
Strict Clippy needs no baseline.

Cargo.lock, toolchain manifests, package manifests/lock, migrations, OpenAPI,
registry, third-party, scripts, ops and workflow changes expand the affected set
to the full workspace. A docs-only PR runs plan/hygiene/ci-ok. Queue runs use the
same affected fast tier as PRs. Only a release-unit dispatch requests the full
Chromium/Firefox suite; fast runs use Chromium, the configured smoke files and
directly changed E2E specs. The planner is the only source for both tiers.

Cut a release unit by dispatching `ci.yml` on the selected `dev` commit. The planner
sets `tier=release`, selects every Cargo member and both configured browsers, and
leaves `e2eFiles=null` for the complete inventory. Its `matrix.include` contract
stays `{browser, project, files, shard, est}`; Rust partitions and both JUnit paths
stay unchanged for test-speed consumers. The follow-up CI-TIERS promotion,
scheduled battery and candidate scheduling work is tracked in the handoff.

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

## Shared build and disk bound

`rust-build` has no matrix. One `cargo nextest archive --tests` invocation compiles
all affected packages with their `full,test-postgres` features. Every DB and unit
partition downloads that same immutable archive and uses `--archive-file`, a
complementary mode filter and `--partition slice:N/total`. Library binaries with a
transitive SQLx dependency remain in DB partitions, together with every integration
binary. No partition invokes a compiler. The five gate executables and the E2E
backend binary are built once alongside the archive; the web job produces one dist.

The full plan is one build, two non-DB partitions and eight DB partitions, replacing
123 builds and 123 test jobs. Browser shards reuse both prebuilt outputs. The
checked-in timing seed contains only observed served-test durations and timestamps;
new trusted dev-push timing caches override it. Regenerate it from the autoshard
record with `E2E_SERVED=1 GITHUB_OUTPUT=/tmp/ci-plan node scripts/ci/e2e.mjs seed`.
The current measured inventory gives 17 browser shards, about five minutes each,
including first-run-solo in shard 1 of each browser.

The planner reserves at most 24 browser shards. When recorded times need more,
it increases the target and uses the existing longest-first duration packer within
that cap, preserving project isolation, file coverage and solo in shard 1. Twice
the seed timings are a regression control. A shard fails planning only when its
estimate plus setup exceeds 80% of the E2E job timeout (24 of 30 minutes).

Wall-clock admission reads the actual workflow `needs` graph and job timeouts,
then compares its longest chain with the ruleset's queue response timeout:
plan 15 → hygiene 15 → rust-build 90 → backend-db 60 → ci-ok 15 = 195 < 240 minutes.
Summed job-minutes are a reported cost metric with an 80% warning, not a queue
deadline. Jobs and disk also warn at 80%; exceeding the job/disk safety caps fails.
Both planners print predicted minutes per job/partition and include them in the
scanned summary for comparison with hosted `report.mjs` receipts.

All caps are provisional until the orchestrator opens this branch as a **draft
PR** and collects the first hosted cold/warm/docs-only/one-crate receipts. These
local measurements are sizing inputs, not hosted proof:

| Setting | Provisional value | Source and headroom |
|---|---:|---|
| Job cap | 60 | Round-6 full reservation 45 jobs (24 shard slots); +33%; round-5 measured plan was 39 |
| Summed-minute warning budget | 320 | Round-6 full reservation 250 job-minutes; +28%; round-5 measured plan was 217 |
| Browser shard cap | 24 | Round-5 CI-shaped seed plan 17 shards; +41%; slower timings repack |
| Disk cap | 57 GiB | `r5-disk.json`: 42.376 GiB shared-build peak; +34.5% |
| Free disk minimum | 3 GiB | Existing extraction reserve, additional to the measured build footprint |
| E2E target/workers | 300 seconds / 2 | Existing autoshard target and round-5 served measurements |
| Setup estimate | 0.5 minutes | Round-5 provisional runner setup allowance; replace with hosted receipt |
| Other job estimates | plan 2, hygiene 3, ci-ok 2, web 8, build 50, unit 3, DB 5, privacy gate 1, E2E-plan 2 minutes | Round-5 `config.json` model; Mac checks/archive/backend timings in verifier §P2-3; hosted setup/cold build unmeasured |

Expected cold wall time is 65–100 minutes; warm 30–55; docs-only 3–8. The 90-minute
cold Rust build remains unproven on the hosted runner. If it exceeds about 70
minutes, separate Clippy from archive compilation before ruleset cutover.

Debug information and incremental builds are disabled. The shared archive needs
more disk than the former six-target groups, so the disposable hosted build runner
removes only the unused SDK directories listed in config (Android, .NET, GHC,
Swift and CodeQL). `disk-budget.py` counts checkout, resolved dependency sources,
a full compiler-cache reserve, artifacts and peak extraction, then refuses more
than the provisional 57 GiB or less than 3 GiB free before publication. The disk-budget workflow
step is mandatory and regression-tested. Extraction jobs need the shared archive's
expanded size too; their hosted disk receipts must pass before the check is enabled.

The old six-target arm64 receipts (9.142 GiB maximum) do not prove the new shared
archive bound. The Round 5 arm64 receipt is recorded below; Linux amd64 and actual
hosted free-space measurements remain required on the first Actions run.

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
gets its own affected proof. Never substitute local receipts or a previous SHA's green.

## Availability notifications

Deployment is GitOps. The deleted script-CD workflow and its tests stay deleted;
`workflows-check` runs `scripts/ci.test.mjs` for the shared CI safety contract.
Probe failures use `scripts/ci/notify-telegram.sh` and never send email. Set
`PROBE_URL` and `CONSOLE_PUBLIC_HOST` as repository secrets and
`CONSOLE_TELEGRAM_BOT_TOKEN` / `CONSOLE_TELEGRAM_CHAT_ID` as repository secrets
or secrets in environment `probe`. After configuring them, set repository variable
`PROBE_ENABLED=true`; until then both scheduled and manual probes stay skipped.
Use **Run workflow** on `probe.yml` to verify access and the Telegram notice path.

## Owner applies the dev ruleset

These commands are instructions only; this lane does not call the GitHub API or
push. Run from the repository checkout with the owner's administrative `gh` login:

```sh
repo=oyatie/console-next
gh api "repos/$repo/rulesets" --jq '.[] | {id,name,enforcement}'
gh api --method PUT "repos/$repo/rulesets/25624651" --input .github/rulesets/dev.json
gh api "repos/$repo/rulesets/25624651"
gh api --method DELETE "repos/$repo/rulesets/25552233"
```

After this lane merges, these commands replace the existing `dev-pr-only` ruleset
and delete the disabled `push-restrictions` ruleset, which public source repositories
cannot enforce. The JSON requires PRs with **zero** approvals, the merge queue, GitHub Actions'
`ci-ok` context, resolved conversations, and blocks deletion/force push. Its empty
bypass list applies to administrators too. Check other active org/repo rulesets
for conflicting approval/direct-push rules before applying. Do not change Actions
permissions or add an administrative check bypass to make a red pass.

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
| Cold release unit | Unmeasured | Pending | Pending | Pending | Actions dispatch URL + candidate SHA |
| Warm release unit | Unmeasured | Pending | Pending | Pending | Actions dispatch URL + candidate SHA |
| Docs-only PR | Unmeasured | Pending | Pending | Pending | plan + hygiene + ci-ok, proof jobs intentionally skipped |
| One crate PR | Unmeasured | Pending | Pending | Pending | planned reverse dependencies + nextest selected packages + ci-ok |

Verifier: run one generated shard per browser using the curated test topology;
run two DB suites through the shared bootstrap/archive commands; confirm every SQLx
suite appears in the DB inventory; exercise a failed rust-build whose dependent
tests skip and verify ci-ok is red; then dispatch the full release unit, inspect JUnit,
traces, privacy controls, cache writes/size and required-check enforcement. The
merge result in GitHub Actions is the final proof.

## Hosted verifier sequence

1. Dispatch a cold release unit with no matching trusted caches. Record the
   candidate SHA, run URL, every job's duration, hit counts and total cache bytes from
   `ci-ok`. Check every SQLx suite is present in the DB inventory and both browsers
   report JUnit. Deliberately fail a build and confirm dependent skips make `ci-ok`
   fail. Inspect a failed browser shard's scanned trace artifact.
2. After the successful queue result lands, the `push: dev` run seeds trusted
   caches. Dispatch again with unchanged locks/toolchain for the warm comparison.
   Re-running a PR, merge group or dispatch alone cannot warm caches: those events
   restore only. Confirm total repository cache bytes remain below
   `cacheBudgetBytes`; all artifacts use `retentionDays`.
3. Open a docs-only PR: only plan, hygiene and the always-reporting `ci-ok` run.
   Then use a leaf Cargo gate crate change to show the affected crate selection,
   skipped web/E2E jobs and a reporting `ci-ok`. Queueing either PR must report
   the same affected fast tier on the merge SHA; dispatch must expand to full proof.
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
`CONSOLE_TELEGRAM_BOT_TOKEN` / `CONSOLE_TELEGRAM_CHAT_ID`. Deployment is GitOps; the superseded script CD workflow and test stay deleted.

## Round 5 proof and scope

The shared archive contains all 734 test binaries (plus 13 required non-test
executables). Its inventory has 1,106 non-DB and 3,524 DB test cases; the filters
are complementary. The full inventory removed the four named obsolete Rust IDs plus the retired
`actual_0227_upgrade_preserves_every_account_key_and_family` baseline ID. Both browser inventories
validate the remaining baseline. At round 5 it had 110 exact IDs, and any executed pass
or deleted ID makes the required check red until that entry is removed.

On macOS arm64, the complete symbol-stripped build, gates and backend measured
42.376 GiB; the shared archive is 7.227 GiB compressed and 28.243 GiB expanded;
test-job peak including checkout is 35.517 GiB. The receipt also counts prior
local archive remnants and library-test outputs, conservatively beyond the
hosted build's outputs. Round 6 uses these measurements for a provisional 57 GiB cap, with a
separate 3 GiB free-space margin. Stripping symbols preserves test names and
JUnit IDs; native backtraces have fewer symbol names. Hosted amd64 must retain
its own receipt and pass the free-space checks after unused SDK removal.

Local checks: full `npm run check` (1,159 web tests and 90 Node CI checks), format,
all three strict Clippy sets, workspace test compilation, 2,009 library tests
(1 existing ignored), all five personal-data gates, actionlint, structural scan,
gitleaks, both browser inventories and the 17-shard timing plan. The regression checks fail 71/74 on public base `5b0e2514`; a detached
`457b0111` checkout isolates 20/74 Round 5 failures (all 90 controls pass on the tip). Both non-DB archive partitions pass all 1,106 tests from the shared archive. The
two DB suites pass all 52 tests across eight partitions after the exact pinned
service preparation and topology bootstrap. JUnit IDs reconcile against the full
inventory with no gaps or duplicates across partitions.
No hosted or sandbox browser run is claimed.

Round 5 changes outside the brief's workflow/docs/file-guard owns are the required
CI helpers and their tests only (no excluded file is changed):

- `scripts/ci.test.mjs`, `scripts/ci-privacy.test.mjs`, `scripts/ci-results.test.mjs`, `scripts/ci-regressions.test.mjs`
- `scripts/ci/baseline.json`, `scripts/ci/config.json`, `scripts/ci/e2e-timings.json`
- `scripts/ci/plan.mjs`, `scripts/ci/e2e.mjs`, `scripts/ci/report.mjs`
- `scripts/ci/rust-build.mjs`, `scripts/ci/rust-tests.mjs`, `scripts/ci/test-results.py`, `scripts/ci/disk-budget.py`

## Files outside the initial owns list

These support the workflow and its required proof (including the explicitly
requested round-2 test topology/scanner). No excluded lane file was touched:

- `.client-data-allow`, `.config/nextest.toml`
- `.github/rulesets/dev.json`, `.github/workflows/workflows-check.yml`
- `e2e/stack/compose.yml`, `e2e/stack/otel-collector.yml`
- `package.json`, `playwright.config.ts`, `vitest.config.ts`
- `scripts/backend-dev.mjs`, `scripts/client-data-scan.py`
- `scripts/ci.test.mjs`, `scripts/ci-cutover.test.mjs`, `scripts/ci-privacy.test.mjs`, `scripts/ci-results.test.mjs`, `scripts/ci-regressions.test.mjs`
- `scripts/check-fixture-ids.mjs`, `scripts/check-fixture-ids.d.mts`, `scripts/fixture-synthetic-ranges.json`
- `scripts/check-repo-files.mjs`, `scripts/check-repo-files.test.mjs`, `scripts/repo-files.policy.json`
- `e2e/helpers/import.ts`, `e2e/helpers/import-layouts.ts`, `e2e/access-parity.spec.ts`
- `e2e/parity/e3.ts`, `e2e/people-actions/register-run.spec.ts`
- `scripts/ci/baseline.json`, `scripts/ci/test-results.py`, `scripts/ci/disk-budget.py`, `scripts/ci/rust-build.mjs`
- `scripts/ci/bootstrap-db.sh`, `scripts/ci/postgres-reconcile-topology.sh`
- `scripts/ci/config.json`, `scripts/ci/versions.json`, `scripts/ci/db-contract.mjs`
- `scripts/ci/e2e.mjs`, `scripts/ci/e2e-timings.json`, `scripts/ci/plan.mjs`, `scripts/ci/gate.mjs`
- `scripts/ci/install-tools.sh`, `scripts/ci/notify-telegram.sh`, `scripts/ci/prepare-db.mjs`
- `scripts/ci/privacy.mjs`, `scripts/ci/scan-uploads.py`, `scripts/ci/sanitize-nextest.py`
- `scripts/ci/public-browser-cache.py`
- `scripts/ci/report.mjs`, `scripts/ci/rust-tests.mjs`

Relocation also updates these Rust-side readers/documentation outside the initial owns:

- `backend/ci/gates/writer-ownership/canonical-enforce.sh`
- `backend/ci/gates/file-size/baseline.txt` (regenerated)
- `backend/ci/gates/writer-ownership/tests/census_executes_against_postgres.rs`
- `backend/ci/gates/writer-ownership/tests/gate_detects_violation.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/company.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/job_position.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/org_unit.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/person.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/company_port_as_runtime_role.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/employment_port_as_runtime_role.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/person_port_as_runtime_role.rs`

## Round 6 proof and scope

The hermetic static input guard runs in hygiene on every change, including docs.
Its privacy fixtures construct synthetic absolute paths from parts. The complete
clean-clone integration test remains a separate local check to avoid recursively
running `npm run check`. Inventory controls execute both actual runner scripts
with valid JSON and a failing inventory exit; removing either exit check is red.
The planner control raises an actual workflow job timeout past the queue deadline.

Touched files are CI-owned: workflow, docs/ci.md, scripts/ci-privacy.test.mjs,
scripts/ci-results.test.mjs, scripts/ci.test.mjs, scripts/ci/{baseline,config}.json and
scripts/ci/{e2e,plan,report}.mjs plus test-results.py and disk-budget.py.
The only file outside CI owns is generated
`backend/ci/gates/file-size/baseline.txt`: `console-gate-file-size --write-baseline`
lowers the stale census-test pin from 1,804 to 1,791 lines. The ratchet failed
before regeneration and then passed (2,193 files, 303 pins, zero violations).
No ops files were added; the existing curated topology scripts stay unchanged.
The orchestrator must collect hosted receipts before enabling the ruleset.

Round-6 local receipts: `npm run check` passes 1,159 web and 96 Node CI tests;
all three exact Clippy commands, format, workspace test compilation, five
personal-data gates, quality ratchet, actionlint and both gitleaks configurations
are green. Both hermetic tests pass, including clean-clone `npm run check`.
The updated results tests fail 5/26 on prior tip `b3f1095e` and 26/26 on public
base `5b0e2514`; all 26 pass on the tip. Each of the three reported mutation
survivors is now killed individually in the lane's detached proof worktree.
Logs and run IDs are under the owner's lane receipts (`r6-*.log`). Hosted/browser
execution remains verifier/orchestrator work; the unmodified 90-minute cold
Rust timeout and all sizing caps require the first hosted receipts.

## GitOps cutover proof (2026-10-23)

The lane is rebased onto public `dev` at `bfc65fc7`, after the requested
`385a97be` cutover. Neither deleted CD file appears in the diff, and the initial
owns list contains no `cd.yml`. Probe remains disabled until its secrets and
`PROBE_ENABLED` are configured. Workflow checks execute the CI contract.

Nine new regression controls cover the cutover, opt-in Telegram probe, both tiers,
actual fast shard selection, Chromium unit-test setup, existing ruleset update,
queue base selection and empty dispatch bases. Eight fail on pre-change tip
`4dd5c041`; the empty-base control fails on the incomplete cutover draft. The stale
topology assertion also fails on that tip: GitOps files under `deploy/` are allowed
by policy and must not be treated as private ops material.

Local receipts are retained in the lane as `r8-*.log`:

- Exact `npm run check` passes in an isolated checkout of `eb9f779a` with a local
  `dev` ref at public `bfc65fc7`: 263 Vitest files / 1,768 tests and 92 Node tests.
  No dependency installation was needed. In the shared worktree, Chromium first
  hit the macOS sandbox boundary; an unsandboxed run then timed out in the
  unchanged onboarding browser test during Vite reloads. Both the base's complete
  1,768-test run and the isolated tip's complete run pass without retries.
- All three exact strict Clippy commands, `cargo fmt --check` and
  `cargo check --workspace --tests` pass. Actionlint, YAML/action properties,
  hermetic static inputs, repository policy (8,245 tracked files), quality ratchet,
  structural/term scans, gitleaks, synthetic fixtures and licences pass.
- A fresh current-source nextest archive, the production image pin and the exact
  CI prepare/bootstrap/partition commands pass two DB suites: 42 unique tests
  across eight partitions, zero failures and no duplicate/missing JUnit IDs.
  The topology census enforces all 20 canonical tables.
- Full release planning selects 196 Cargo members, two unit partitions, eight DB
  partitions and 19 browser shards. Both browsers reserve first-run-solo in shard
  1. Real Cargo metadata plus controlled docs-only and one-crate diffs exercise
  the planner and actual gate CLI: unrelated jobs skip and `ci-ok` reports success.
  These controls demonstrate selection, not hosted timing or execution receipts.

Three gates have identical findings on `4dd5c041` and the tip. No baseline or lint
was weakened:

| Gate | Inherited finding | Base/tip receipts |
| --- | --- | --- |
| file-size | `app/tests/entity_registration_void_api.rs`: 608 code lines, ceiling 300 | `r8-base-file-size.log`, `r8-file-size.log` |
| rls-arming | Seven bare-pool queries in `app/src/http/support_reference_platform_tests.rs`, `crates/platform/access/src/grants_store/tests.rs` and `crates/platform/test-support/src/lib.rs` | `r8-base-rls-arming.log`, `r8-rls-arming.log` |
| audit-coverage | `app/src/http/support_reference_platform_tests.rs::fixture` lacks an audit event | `r8-base-audit-coverage.log`, `r8-audit-coverage.log` |

Classification, pii-no-logs and tenant-isolation pass. The shared checkout's old
private-history `dev` ref also makes the default licence diff lack a merge base;
the base reproduces it, and the isolated checkout with public `dev` passes the
unchanged command. All files outside initial owns are listed above; this round
changes only the workflow/ruleset/docs, package check wiring and CI helper tests.

The verifier must run the merge-result workflow and one emitted shard per browser,
then the long release-unit dispatch. Hosted cold/warm/docs-only/one-crate receipts,
cache totals, live Telegram delivery and owner ruleset application remain external
proof. No full E2E, full workspace DB sweep, scheduled battery, push or GitHub API
write was performed by this lane.
