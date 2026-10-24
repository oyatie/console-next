<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# GitHub Actions proof

`backend` and `web` remain the live required checks; both always propagate `ci-ok`.
The owner switches the ruleset to `ci-ok` after this PR merges. Pull requests get affected proof;
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
| `web-check` | Existing `npm run check`: contracts, TypeScript, lint, Vitest, production build, bundle budget, secret/licence/fixture checks |
| `rust-build` | Format; default, `full` and `full,test-postgres` Clippy; one affected-workspace test archive per architecture; one backend binary for every browser shard |
| `backend-test` | Non-DB library tests from the shared archive, using nextest `slice:` partitions |
| `backend-db` | All remaining tests, including mixed SQLx library tests, from the shared archive, with an isolated PostgreSQL service per partition |
| `e2e-plan`, `e2e` | Existing duration bin packing; fast Chromium smoke/changed specs, full Chromium and Firefox per release unit; clock projects stay serial; first-run-solo is always in browser shard 1 |
| `ci-ok` | Every `console-gate-*` package discovered from `backend/ci/gates/*/Cargo.toml`, built offline and executed without arguments on every change (including docs-only); then enforce required results and plan-authorized skips |
| `backend`, `web` | Always report success only after `ci-ok` succeeds, including docs-only runs |

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

Cargo.lock, toolchain manifests, package manifests/lock, migrations, OpenAPI,
registry, third-party, scripts, ops and workflow changes expand the affected set
to the full workspace. A docs-only PR runs plan/hygiene/ci-ok (including every
backend code gate) and both required reporting checks. Queue runs use the same
affected fast tier as PRs. Only a release-unit dispatch requests the full
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
never save. Only the measured-duration cache may also save after a successful
release dispatch on dev. `setup-node` has no implicit cache writer. sccache is bounded by config.
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
binary. No partition invokes a compiler. All discovered gate executables and the E2E
backend binary are built once alongside the archive; the web-check job produces one dist.

Browser shards reuse both prebuilt outputs. The checked-in timing seed contains
observed served-test durations and timestamps; timing caches from trusted dev pushes
and release dispatches on dev override it. The gate folds measured shard results
into the restored record with the existing rolling average, preserving unvisited
tests and aging out stale entries. Each run/attempt saves a distinct cache key. Regenerate from the autoshard record with
`E2E_SERVED=1 GITHUB_OUTPUT=/tmp/ci-plan node scripts/ci/e2e.mjs seed`.

The planner reserves at most 24 browser shards. When recorded times need more,
it increases the target and uses the existing longest-first duration packer within
that cap, preserving project isolation, file coverage and solo in shard 1. Twice
the seed timings are a regression control. A shard fails planning only when its
estimate plus setup exceeds 80% of the E2E job timeout (24 of 30 minutes).

Wall-clock admission reads the actual workflow `needs` graph and job timeouts,
then compares its longest chain with the ruleset's queue response timeout:
plan 15 → hygiene 15 → rust-build 90 → backend-db 60 → ci-ok 15 → backend/web 5 = 200 < 240 minutes.
Summed job-minutes are a reported cost metric with an 80% warning, not a queue
deadline. Jobs and disk also warn at 80%; exceeding the job/disk safety caps fails.
Both planners print predicted minutes per job/partition and include them in the
scanned summary for comparison with hosted `report.mjs` receipts.

Job, disk and cache caps and provisional duration estimates live in
`scripts/ci/config.json`. Validate them with hosted cold/warm/docs-only/one-crate
receipts before the owner enables the new ruleset.

Debug information and incremental builds are disabled. The shared archive needs
more disk than the former six-target groups, so the disposable hosted build runner
removes only the unused SDK directories listed in config (Android, .NET, GHC,
Swift and CodeQL). `disk-budget.py` counts checkout, resolved dependency sources,
a full compiler-cache reserve, artifacts and peak extraction, then refuses more
than the provisional 57 GiB or less than 3 GiB free before publication. The disk-budget workflow
step is mandatory and regression-tested. Extraction jobs need the shared archive's
expanded size too; their hosted disk receipts must pass before the check is enabled.

## Repository file policy

`npm run check` starts with `node scripts/check-repo-files.mjs`: it checks committed
paths changed from the merge base with the PR's `origin/$GITHUB_BASE_REF`, or `dev`
locally. Pass another base ref explicitly when needed. Hygiene always runs
`node scripts/check-repo-files.mjs --full`, including on docs-only changes and
merge groups, so the required `ci-ok` covers the whole committed tree.

`scripts/repo-files.policy.json` owns the restricted paths, file patterns, exact
exceptions and 5,000,000-byte maximum. Failures name the path and rule. Deploy
files remain allowed; spreadsheet exceptions do not exempt other document types
or the size limit. The curated topology files live in `e2e/stack/`
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

## Rebase proof (2026-10-24)

Rebased onto `public/dev` at `ebe3857c3` (#37, #38 and #40). The package-script
conflict keeps G5's person-read check and this lane's repository/CI checks.
`backend` and `web` retain their live required-check names. `ci-ok` now restores
the existing lock-keyed registry cache, fetches locked dependencies for cold runs,
and discovers, builds offline and executes all 13 code-gate packages itself,
including on docs-only changes. There is no separate conditional code-gate job
or gate-binary upload. The planner accounts for the gate work inside `ci-ok`.

Local proof: 1,962 unit tests across 286 files; all 13 real code gates; six focused
gate/result controls; actionlint/YAML, fmt, all three Clippy feature sets,
`cargo check --workspace --tests`, the file-size ratchet against `public/dev`,
quality ratchets, types/lint/build/bundle, licence headers against `public/dev`,
fixture IDs, dependency licences and merge-range gitleaks pass. With the lane
`db.env` sourced, the canonical adapter suite passes 124/124 (all test binaries);
the topology crate results and exact base reproduction are listed below. Gate controls
cover every current manifest plus a synthetic future gate, a red gate, a missing
binary, an empty discovery and a failed build. The three focused backend controls
failed before the fix on `c929ca367` in the lane's `rebase-base` worktree.

Round 10 closes the inherited workflow, file-policy, synthetic-fixture and
canonical-census failures on the rebased public tree. CodeQL uses blocked egress
and SHA-pinned GitHub-owned actions. API compatibility decisions live next to the
OpenAPI contract at [release-api-compat-2](../backend/openapi/release-api-compat-2.md);
support-access decisions live in [security](security/support-access.md).
The leave/import definer's required Person writes are named in the census with
their concrete function/trigger path. No writer violation is quarantined.
Current local receipts and remaining hosted proof live in the lane handoff.

## Post-flip proof receipt

No hosted run is fabricated. Fill this table from Actions job durations, scanned
cache counters and repository cache usage from the hosted runs:

| Run | Before minutes | After minutes | Cache hit % | Total cache bytes | Evidence |
| --- | --- | --- | --- | --- | --- |
| Cold release unit | Unmeasured | Pending | Pending | Pending | Actions dispatch URL + candidate SHA |
| Warm release unit | Unmeasured | Pending | Pending | Pending | Actions dispatch URL + candidate SHA |
| Docs-only PR | Unmeasured | Pending | Pending | Pending | plan + hygiene + ci-ok (all code gates) + backend/web, other proof jobs skipped |
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
3. Open a docs-only PR: only plan, hygiene, `ci-ok` (all code gates), `backend` and `web` run.
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

## Files outside the initial owns list

These support the workflow and its required proof. No excluded lane file was touched:

- `.client-data-allow`, `.config/nextest.toml`
- `.github/rulesets/dev.json`, `.github/workflows/workflows-check.yml`
- `e2e/stack/compose.yml`, `e2e/stack/otel-collector.yml`
- `package.json`, `playwright.config.ts`, `vitest.config.ts`
- `scripts/backend-dev.mjs`, `scripts/client-data-scan.py`
- `scripts/backend-code-gates.test.mjs`
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
- `backend/ci/gates/file-size/baseline.d/rv-SEC-K1-c-access-log-legal-hold.txt` (folded by the generator)
- `backend/ci/gates/writer-ownership/tests/census_executes_against_postgres.rs`
- `backend/ci/gates/writer-ownership/tests/gate_detects_violation.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/company.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/job_position.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/org_unit.rs`
- `backend/crates/ontology/canonical-adapter-postgres/src/person.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/company_port_as_runtime_role.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/employment_port_as_runtime_role.rs`
- `backend/crates/ontology/canonical-adapter-postgres/tests/person_port_as_runtime_role.rs`


Handoff amendments outside the repository: `units/cicd/briefs/CI-1.md` and
`units/cicd/ADR-CICD-enterprise.md` align the brief and ADR with CI-TIERS.
