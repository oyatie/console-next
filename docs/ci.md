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
| `desktop-test` | Locked desktop crate unit tests on desktop/shared changes; Linux Tauri dependencies installed before `npm run desktop:test -- --locked` |
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
`e2eReservedShards` is the initial planning reservation, shared by the selected
browsers. Measured suites may expand beyond it up to `maxJobs`, after accounting
for the other required jobs. Bin packing includes browser setup and leaves every
shard below 80% of the E2E workflow timeout. Only exhaustion of that total job
budget blocks suite growth; minute estimates remain warnings. Whole spec files
stay together, so a file too long to fit alone gets a specific headroom error.
The growth regression uses a fixed synthetic seed: doubling its durations grows
eight shards to sixteen, without depending on the current browser inventory.

The plan's Cargo metadata command runs locked and offline, with a deadline from
`jobMinutes.plan` that also bounds the rustup proxy's cold toolchain download.
A stalled command fails promptly instead of spending the job timeout waiting
for a blocked download; fresh runners can still install the pinned toolchain.

`test-results.py` compares exact JUnit failure IDs against `scripts/ci/baseline.json`:
deterministic trunk reds are reported while they still fail. A deterministic pass
blocks with “fixed: remove from baseline”; a deleted test blocks in the nextest
or Playwright inventory. Unrelated partitions do not count as fixes. A new red,
runner crash, missing report or expired/unowned entry blocks. No retry hides a red.
Case-level Playwright test timeouts count as failed test IDs; suite-level errors,
worker crashes and unaccounted error counters still block.

Entries have `class: deterministic | flaky`. Flaky entries accept either result,
but require at least two distinct `evidence` receipts with `runId`, ISO `date` and
`result: passed | failed`, including both outcomes. Their expiry is at most seven
days after the latest receipt, versus a maximum 14-day deterministic renewal.
The flake budget lives in `config.json`; hygiene enforces it and scanned job
summaries show usage and D-7 expiry warnings. Refreshed entries name the
accountable lane in `ownerLane`, retain fresh failure receipts, and drop observed
green identities.

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

Base comparisons share `scripts/git-base.mjs`: an explicit CLI base takes precedence,
then `CI_BASE_SHA`, the PR/merge-group/push event base, `origin/dev`, and `public/dev`.
A missing requested commit refuses the check;
it never silently substitutes another base. With no usable evidence the error names
`CI_BASE_SHA` and the remote refs to fetch. Local `dev` is never a default: it can
still refer to the private repository. Both CI and workflows-check fetch full history
without creating a local branch. To reproduce checkout behavior, clone the public
repository, detach at the tested commit, delete the local `dev` branch, and use a
fresh home/cache with no orchestra queue or Rust on PATH for non-Rust jobs.

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
Apalis owner/runtime/admin URLs instead target `apalisContractDatabase` from the
same config. Bootstrap creates that isolated `*_contract` database owned by
`console_app`; its destructive schema contract never uses the SQLx control database.

## Caches, artifacts and public data

Actions use SHA pins and the GitHub-owned `actions/*` and `github/codeql-action/*`
namespaces, plus `step-security/harden-runner`.
Harden-runner blocks egress outside each job's explicit allow-list. Tools are
checksum-verified release archives from `scripts/ci/versions.json`, including
actionlint, nextest, cargo-deny and sccache. The tool archives were downloaded and hashed
locally; no third-party installation action is involved.
Both actionlint jobs use the [pinned release binary](https://github.com/rhysd/actionlint/releases/tag/v1.7.12),
so workflow linting needs only GitHub release downloads, without Docker Hub.
`scripts/ci/egress.mjs` is the per-tool endpoint map. Every block-mode job has
its own explicit list, generated by `node scripts/ci/generate-egress.mjs`;
`scripts/ci-egress.test.mjs` resolves its actions, commands
and subprocesses in invoked npm scripts, Node test entrypoints (including flags
and relative imports), shell scripts and Python Rust subprocesses against that map,
rejecting both missing and unused entries. Reach reads the versioned Cargo manifests
with Python's standard `tomllib` through `scripts/reach-metadata.py`; it needs no
Cargo or rustup. The reader follows workspace globs, inherited dependencies and
implicit path members, preserving the release feature calculation without a second
package list or a generated snapshot. Rust jobs still need `static.rust-lang.org`
for the pinned toolchain on a fresh runner. Node setup includes its
[direct-download fallback](https://github.com/actions/setup-node/blob/820762786026740c76f36085b0efc47a31fe5020/src/distributions/official_builds/official_builds.ts).
Sccache uses the local `SCCACHE_DIR`; its remote transfers use `actions/cache`.
Docker Hub endpoints belong only to E2E's Compose pulls, including Docker's
[CloudFront download host](https://docs.docker.com/desktop/enterprise/allow-list/);
GHCR belongs to CodeQL's pack downloads. Service images are pulled before job
steps and before harden-runner starts. The run-40059693228 fixture independently
checks checkout and the planner's implicit rustup download. Mutation controls
remove every required endpoint and add unused ones, including broad wildcards.
The generator writes each hardening action and space-separated input as literal
per-job YAML. Its `--check` mode rejects drift; the CI safety suite also refuses
any checkout without `github.com:443` and any empty block-mode list. Checkout
requires `github.com:443` for git plus `api.github.com:443` and
`codeload.github.com:443` for the REST archive fallback. The temporary backend/web
contexts now checkout with that same contract, rather than start with an empty
block list. Block mode remains enforced throughout.

Round 15 / hosted run 40107495883: the previous scanner missed `node --test` and
its imported reach CLI regression, so both hygiene and workflow linting invoked
Cargo without toolchain egress. The updated contract reproduces those two refusals
against the unchanged `1cb376b7e` job/step lists. The fix removes Cargo from reach;
their existing literal allow-lists now suffice, with no workflow policy change.
The reach regression shadows cargo/rustc/rustup with refusing executables. Separate
controls plant a Rust subprocess behind Node test flags, an import and another Node
entrypoint, and remove toolchain access from every actual job. Test harnesses that
provide a synthetic executable PATH stay local; invalid Rust/Telegram inputs also
use refusing tool stubs. Production scripts with PATH overrides still get inspected.
The manifest reader matches Cargo locally: 196 members and 79 shipped dependencies.

All 16 jobs were audited for the same toolchain path:

| Workflow job(s) | Toolchain path and contract |
| --- | --- |
| `ci:plan` | `plan.mjs` → Cargo metadata; toolchain endpoint allowed. |
| `ci:hygiene`, `workflows-check:workflows` | Node safety tests → reach; no Rust invocation after this fix. |
| `ci:web-check` | Reach is Rust-free. Its allow-list conservatively retains the licence renderer's optional `--cargo` mode, although `npm run check` uses `--check`. |
| `ci:rust-build` | fmt, three Clippy sets, archive/binary build and disk-budget metadata; toolchain and crate endpoints allowed. |
| `ci:backend-test`, `ci:backend-db` | Archived nextest runner; toolchain endpoint allowed, no registry downloads. |
| `ci:desktop-test` | npm script → Cargo test; toolchain and crate endpoints allowed. |
| `ci:ci-ok` | Locked fetch plus discovered code-gate builds/runs; toolchain and crate endpoints allowed. |
| `ci:e2e-plan`, `ci:e2e` | Prebuilt browser inventory/shards; no Rust invocation. |
| `ci:backend`, `ci:web` | Result propagation only; no Rust invocation. |
| `codeql:analyze`, `probe:probe`, `probe:notify` | CodeQL, HTTP probe or Telegram; no Rust invocation. |

Local reproduction for round 15:

```sh
node scripts/ci/generate-egress.mjs --check
node --test scripts/ci.test.mjs scripts/ci-privacy.test.mjs scripts/ci-results.test.mjs scripts/dev-secrets.test.mjs scripts/check-repo-files.test.mjs
node scripts/check-reach.mjs
```

The verifier must rerun the Actions merge-result proof, including both lint jobs
under harden-runner block mode. Local contract tests do not emulate the hosted firewall.
Local checks pass: `npm run check` (2,094 unit tests, 118 Node checks), fmt, all
three Clippy feature sets, workspace test type-checking, all 13 discovered code
gates, file-size/quality ratchets, actionlint and privacy scans. The exact hygiene
safety step also passes 117 checks with Rust executables blocked. No Rust crate
or DB behavior changed, so this round adds no DB or E2E suite.
Files outside the original brief's named paths: `scripts/check-reach.mjs`,
`scripts/check-reach.test.ts`, `scripts/reach-metadata.py`, `scripts/ci/egress.mjs`,
`scripts/ci-egress.test.mjs`, `scripts/ci-delivery.test.mjs`,
`scripts/ci-results.test.mjs` and `scripts/ci.test.mjs`.

Local reproduction for run 40090735082 / round 14:

```sh
node scripts/ci/generate-egress.mjs --check
node --test scripts/ci-delivery.test.mjs scripts/ci-egress.test.mjs
env -u BACKLOG_QUEUE_DIR node scripts/check-reach.mjs
RUSTC_WRAPPER=sccache npm run desktop:test -- --locked
CI_BASE_SHA=df5feeb QUALITY_BASE=df5feeb RUSTC_WRAPPER=sccache npm run check
```

The untouched `b5a0ffc76` worktree failed three new controls: empty block lists,
missing generated-input verification and missing desktop CI. Its no-queue reach
CLI was already green; that behavior is retained and now checked in the CI
safety suite. A separate fail-before control proves that shell configuration
assignments must not become network allowances (the desktop test origin is
compiled configuration). Desktop's nine tests pass locally. The hosted rerun
must confirm the effective harden-runner input and checkout, then the dependent
jobs; static generation does not reproduce the hosted firewall itself.
The generated `codeql.yml` and `workflows-check.yml` changes are outside the
brief's individually named workflows and keep the same shared endpoint contract.

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
The planner lists specs from the checked-out merge result on every run. Browser
discovery matches `**/*.spec.ts`, so Node helper tests cannot execute while the
JSON inventory is collected. Hygiene and `npm run check` run the generator's
`check-seed` mode against both configured release browsers; a renamed or deleted
timing key fails until the seed is regenerated. New specs use the autoshard's
existing duration estimate until their first measured run. Failure quarantine
stays separately owned and validated against the live inventory; generation never
adds, renews or removes quarantine entries.
Node helper tests run explicitly with `node --test` in `npm run check`.

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
Archive-only jobs perform that free-space check before extraction without deleting
SDKs. In run 40068047426, DB partition 1 lost runner communication during SDK
cleanup, before credentials, bootstrap or tests; GitHub's check annotation confirms
the runner loss, rather than a test hang or job timeout.

Archive tests resolve executable and fixture paths from runtime Cargo environment
variables, as required by [nextest relocation](https://nexte.st/docs/ci-features/archiving/).
Wall-clock inbox assertions reserve all nextest slots so concurrent migrations
cannot distort their measurements. The 2,000-person fixture still creates every
person through HTTP, with bounded concurrency derived from its pool's existing
source cap; the 300 ms read assertion and 360-second test ceiling are unchanged.
Once setup completed locally, that assertion exposed an empty account-work source
expanding the entire effective-access catalog. It now first checks its own grant
and passkey predicates, returning an empty page when neither can contribute work.
The DB regression removes catalog read privileges and proves an empty source
still succeeds; scheduled notices and personal security tasks retain their journey tests.

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

## Round 13 hosted failures

Run [40068047426](https://github.com/oyatie/console-next/actions/runs/40068047426)
at `79e3b7ba` supplied the failure cases. The relevant product tests and migrations
are byte-identical to `public/dev` (`df5feeb`), confirmed with `git diff`.
Local negative controls reproduced the fixture classifier failure, leaked trigger
EXECUTE permission, Apalis database guard, relocated gate executable failure,
JSON refusal mismatch and the 360-second inbox setup timeout. An explicit
nanosecond timestamp reproduces the Linux/PostgreSQL precision mismatch on macOS.
New controls also fail before the npm script egress discovery, isolated Apalis
URL preparation, archive-only SDK cleanup removal and empty account-source fixes.
The hosted governance case passed locally in isolation; its CI profile now reserves
all test slots, retaining its production source timeout.

Round 13 edits outside the workflow/scripts/docs slice (all permitted by the brief):

- `backend/app/src/action_inbox/sources/grants.rs`
- `backend/app/src/http/redact.rs`
- `backend/app/src/http/redact_tests.rs`
- `backend/app/tests/dispatch_pipeline_api.rs`
- `backend/app/tests/entity_registration_void/concurrency.rs`
- `backend/app/tests/entity_registration_void/replay.rs`
- `backend/app/tests/inbox_journey.rs`
- `backend/ci/gates/file-size/tests/ratchet.rs`
- `backend/ci/gates/vendor-lockin/tests/gate_detects_violation.rs`
- `backend/crates/entity/adapter-postgres/tests/registration_end.rs`
- `backend/crates/entity/domain/src/registration_classification.rs`
- `backend/crates/platform/access/src/grants_store/tests/revisions.rs`
- `backend/crates/platform/db/migrations/20261024080000000_revoke_import_rollback_trigger_execute.sql`
- `e2e/refusal-contract.spec.ts`
- `scripts/check-license-headers.mjs`
- `scripts/check-license-headers.test.ts`

The direct-dependent sweep also reached a recruiting journey absent from the lost
hosted partition. Its preflight refusal lost `checks` and `publishable` in the
shared error envelope. The middleware now preserves typed 4xx extension fields;
5xx responses retain their existing generic message and outer-field stripping.
The base fails both the journey and the new focused redaction regression.

`e2e/refusal-contract.spec.ts` covers the same refusal through a browser-created
session and the real HTTP stack, then reads the unchanged draft. The verifier
runs it with the full-feature backend in Chromium and Firefox.

The licence-header CLI honors the planner's existing `CI_BASE_SHA`, with an
explicit CLI argument taking precedence. Round 16 replaces its local `dev`
fallback with the shared resolver above. Its CLI regression fails before this change; the
complete `npm run check` now passes even when a checkout retains an unrelated
private `dev` ref. No baseline or lint is relaxed.

Round 13 local proof includes 3,177 distinct passing cases across an 81-crate
sweep of touched crates and direct dependents, 41 relocated gate tests and 17
tests through the pinned-image bootstrap. The broad sweep found the recruiting
failure above; the rebuilt application suite proves its fix. `npm run check`
passes 2,094 Vitest cases and 109 Node cases; format, all three workflow Clippy
sets, workspace test compilation, all 13 discovered code gates and both ratchets
pass. No skip, quarantine, retry policy or performance budget was added.

Latency evidence needs the hosted merge-result proof: the complete 2,000-person
journey passed in 193 seconds, but a later application sweep passed 669/670 cases
with that journey's p95 at 400 ms under shared-host load. A controlled comparison
against the same retained 2,000-person database exceeded the unchanged 300 ms
assertion on the base (371 ms) and passed on the tip (266 ms). An experimental
`ANALYZE` made latency worse and was removed. The verifier must specifically
confirm this journey and governance on the isolated hosted runner, alongside the
new refusal E2E in both browsers; the shared Mac is not the release gate.

Temporary profiling edits to `backend/app/src/action_inbox.rs` and
`backend/crates/hr/adapter-postgres/src/directory/register_review.rs` were restored,
and `backend/app/tests/inbox_profile_ci1.rs` was removed. The lane's local
`db.env` admin credential was rotated after a diagnostic printed its temporary
URI; both admin URLs were updated and verified without changing runtime or owner
credentials. No credential or diagnostic fixture was added to the repository.

## Round 16 checkout replay

The public repository was cloned with full history and remote refs, detached at
the candidate commits, and the local `dev` branch removed. Unpublished fixes
were imported by bundle; no private remote or branch was imported. Non-Rust jobs
used a fresh Linux home, no orchestra queue/pointer and a PATH without Rust.
An initial x86 emulation attempt exposed child Node processes receiving SIGSEGV;
the retained diagnostic identifies the signal. Native Linux ARM then passed the
same workflow contracts. Rust checks and archived test partitions used macOS and
the prescribed lane target. Hosted Ubuntu merge-result proof remains required.

The replay found both the reported reach failure and a second bare `dev` read in
standing-text. Both now share the resolver. The standing-text negative control
passed an unavailable CI commit on the previous tip; it now refuses it. Branch
scanning and backlog comparisons also use the resolver: their negative controls
previously returned success with an invalid `CI_BASE_SHA`, and now return their
documented refusal statuses. Missing references, malformed event JSON, explicit
base precedence, PR/queue/push events and both public remote fallbacks are covered.
Workflows-check now fetches the base history too; the contract refuses local
branch creation as a workaround.

Command lists were emitted from both YAML workflows, preserving step commands,
conditions and environments. Local replay supplies event/plan/matrix values;
Actions service operations, authenticated cache accounting and uploads remain
hosted proof. The complete web command passed 2,094 Vitest cases in 292 files and
124 Node cases. Both Rust unit partitions passed 576 cases each. All 13 discovered
code gates, format, three Clippy feature sets, workspace test compilation, both
ratchets and the production-image role bootstrap passed. No lint, test budget,
baseline, quarantine or retry policy was relaxed in this round.

| Job | Local command result |
| --- | --- |
| `plan` | 0 |
| `hygiene` | 0 |
| `web-check` | 0 |
| `desktop-test` | 0; 9 native tests, Linux dependency install checked separately |
| `rust-build` | 0; 821 archived binaries, backend builds and disk check |
| `backend-test` | 0 / 0 |
| `backend-db` | 0 / 1 / 1 / 1 / 1 / 1 / 1 / 1; 3,976 passed, 17 failed, 1 timed out |
| `e2e-plan` | 0; one fast Chromium shard containing all four selected files |
| `e2e` | 1 before any browser test: the shared Docker daemon exhausted its network address pools |
| `ci-ok` | 1; refuses the failed DB and browser dependencies |
| `backend` | 1; correctly propagates `ci-ok` failure |
| `web` | 1; correctly propagates `ci-ok` failure |
| `workflows-check / workflows` | 0 |

The unpartitioned DB inventory contains 4,002 cases, including eight pre-existing
ignored cases; the eight partitions executed the other 3,994 without retries.
Authenticated cache-total reporting could not be measured locally: the CLI
refused the missing Actions token. The actual task base `df5feeb` was compiled
separately. Governance requester
separation, support-approval inbox visibility, and the workbench change-request
case fail there too. Additional DB failures are retained in JUnit; several did
not reproduce in diagnostic controls and remain reported as local flakes.
The browser installer, distribution manifest and upload privacy scan passed;
backend startup failed at Docker network allocation. The verifier must run the
merge-result workflow and a real Chromium/Firefox shard with fresh Docker
capacity, and inspect every retained DB failure. Hosted timing/cache receipts
remain required.

Round 16 files outside the initial workflow/CI-helper/file-policy slice:

- `scripts/backlog-claims.mjs`
- `scripts/check-ai-quality.mjs`
- `scripts/check-license-headers.mjs`
- `scripts/check-license-headers.test.ts`
- `scripts/check-person-reads.mjs`
- `scripts/check-reach.mjs`
- `scripts/check-reach.test.ts`
- `scripts/check-standing-text.mjs`
- `scripts/client-data-scan.py`
- `scripts/git-base.mjs`
- `scripts/git-base.test.mjs`
- `scripts/quality/ratchet.mjs`

No excluded lane file or generated file was edited.

## Round 17: current-dev replay and resource cleanup

The lane's 27 commits were rebased onto public dev
`09d495cd559975c20e26f0feec7f4c702a79eddd`. Base and candidate use independently
compiled Linux archives and the same partition runner, bootstrap, Postgres pin
and nextest profile. For a local base/tip comparison, give each checkout its own
clean target contents, even when its `CARGO_TARGET_DIR` path must stay fixed.
Share sccache, not raw Cargo outputs across checkout roots. Record the source
commit and target provenance before accepting an archive as proof; immutable
archives can still contain stale binaries if their producer reused mixed outputs.

The public-dev replay executes 4,052 DB and 1,158 non-DB cases. Its 23 DB reds
include invalid approval fixtures, missing private harness paths and timestamp
precision assertions; the unit red is the synthetic registration census. The
readiness receipt compares all 18 round-16 failures individually and lists every
job exit. Only standing reds proven by that public-dev replay may be quarantined:
exact test, owner, reason, UTC receipt, expiry and a separate handoff backlog row.
A passing deterministic entry fails until removed. First-run-solo is never
quarantined. The new standing entries expire on **2026-10-31**.

The retained round-16 rollback binary passes alone in **38.985 s** under its
original **360 s** ceiling. Its prior **360.013 s** timeout is contention; the
2,000-person capacity proof now reserves the partition's nextest threads without
changing its timeout, assertions or retry policy. The clean candidate completes
the same capacity proof in **15.137 s** inside its partition.

`backend-dev --reset` releases its own Compose volumes and network on exit,
failed startup, SIGINT and SIGTERM. Playwright permits graceful teardown. Four
subprocess controls fail before that change and pass afterward. The upload
scanner also scans multipart headers, fields, nested workbook bytes and epilogues
in failed browser traces; eleven controls and an actual captured request prove
that it refuses private data, opaque bytes, unsupported encodings and truncation.

The workflow fixtures reuse the verified-person and runtime-role helpers; the
generated size pin shrinks 967→956. A domain-alias assertion uses DB-precision
time. The browser journey fixes preserve access-link position while support
capabilities load and assert the actual nested posting response. The readiness
receipt lists all files outside the original CI helper surface; no excluded lane
file was edited. File-size pins were changed through the repository generator.

Local replay does not emulate GitHub action services, authenticated cache usage
or hosted egress enforcement. Merge-result CI and the release-unit dispatch are
the authoritative hosted proof and supply the cold/warm/docs-only timing table.
Ruleset application and pushing remain owner actions.
