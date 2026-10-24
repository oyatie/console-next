<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# One 업무함 (ECO-G2)

Home reads `GET /api/v1/me/action-inbox` for work. The server owns membership,
permissions, the five saved filters and immutable keyset traversal. A failed source is named with a support reference while healthy work stays usable;
a bounded or partial count says `total_is_exact: false`. Source deadlines
produce calendar-day D-n on the database clock. Statutory dates use the statutory
register, and the renewal horizon uses `hr.contract_soon_days`.

## Home parity

| Former Home work | Server source / item kind | Resolving destination |
| --- | --- | --- |
| Approval by another drafter | OrgChange / org_change_approve | Inline pending-step approval and record review |
| Own draft or prechecked change | OrgChange / org_change_draft | Organization change, edit |
| Rejection awaiting redraft | OrgChange / org_change_rejected | Organization change, rejection |
| Settlement after application | OrgChange / org_change_settle | Organization change, settle |
| Due approved change | OrgChange / org_change_apply | Inline consequence-confirmed application |
| Own change awaiting someone else | OrgChange / org_change_waiting | Organization change, current step |
| Future approved change | OrgChange / org_change_scheduled | Organization change, effective date |
| HR/HQ exit confirmation and settlement | HrExit / hr_exit_confirm, hr_exit_confirm_hq, hr_exit_settle | Exit case at its next action (`j5-exit.spec.ts`, HQ confirmation / settlement / rejection) |
| Failed scheduled action | HrLifecycle / lifecycle_apply_failed | Personnel card, failure reason |
| Open correction request | HrRequests / hr_request | Change request selected by id |
| Incomplete statutory register | HrRegister / register_review | Personnel card |
| Identity confirmation | HrIdentity / identity_review | Personnel card |
| Missing home branch | HrBranch / home_branch_review | Personnel card |
| Contract ending in reminder window | HrContract / contract_renewal | Personnel card, renewal sheet (`j3-renewal.spec.ts`) |
| Pending insurance filing | HrInsurance / insurance_filing | Statutory filing panel |
| Unlock needing a second person | PeriodUnlock / period_unlock | Period lock, selected request (`period-unlock-approve.spec.ts`, live arrival / reject / approve) |
| Unconfirmed own grant | GrantNotice / grant_notice | Inline notice confirmation (`period-unlock-approve.spec.ts`, disclosure / confirmation) |
| Tenant support approvals | SupportAccess / support_access | Support access audit with the selected request (`support-access.spec.ts`) |
| Setup work | Setup / setup_* | Existing authorized setup rail, once inside 업무함 (`import-reds-layout.spec.ts`, arrival hold) |
| Operating account with one passkey | GrantNotice / account_security | Inline second-passkey registration and account link (`setup-truth.spec.ts`, button / account link / removal; `d26-solo-exit.spec.ts`, sole remaining row) |

The OrgChange and HrExit DB source tests cover each state and denial. The release
journey tests cover setup, identity, branch, renewal policy, grant notices, unlocks,
refused readers, the synthetic 2,000-person API workload and cursor admission under
inserts. Existing action-inbox API tests retain legacy-source authorization and RLS
proof. Web tests cover filters, pages, deadlines and refresh; inbox E2E covers actual
two-tab resolution, axe, both themes and desktop/mobile widths.

The people API journey compares every pending filing and its register-derived D-n
with the owning statutory API, then resolves a filing and withdraws a request.
The filing scan advances past resolved history without a raw-row ceiling. Terminal
receipts are filtered after the candidate limit so their lateral lookups stay bounded.
The ordinary statutory panel and Workbench retain their exact-count read.

The release mounts the queue without workspace. Workflow, dispatch, work order,
support, payroll and governance contribute only when their own compiled module is
on. Source-specific SSE topics invalidate the queue. Account work emits a payload-free
`inbox` hint, so its holder needs no user/role administration grant. Own-write echo
and sheet holds keep record snapshots stable while the queue still refreshes.

## Round 5 consumer regressions

Rebased onto public/dev `ebe3857c3`. The bounded-read browser test scopes Home's
retry to the 업무함 alert and checks its support reference before pressing it;
the shell's separate checklist retry remains covered. Change requests carry the
subject's current person name (the requester for non-person subjects), and unlock
requests carry the requester's current display name. Both remain display-ready in
Workbench, while the typed context retains the localized decision facts on Home.
`workbench_inbox_requests.rs` creates both request kinds through the product API
and checks their mounted Workbench entries; both fail with
`action_inbox_unavailable` on rebased pre-fix `7330298ed`.

The setup rail stacks its actions below the title when its own container is
narrow, including inside the Home card at 390 px. The browser regression checks
every first-step action's bounds and accessibility. Due/urgency ordering is deferred:
changing the immutable creation-time cursor needs a separate source-wide traversal
change rather than sorting only the loaded browser page.

Round-5 logs are in `lanes/eco-g2-inbox/round5-logs/`. The exact `npm run check`
passes in the isolated proof clone with `dev` at the public base: **2,043 Vitest
tests**, **3 Node tests**, production build/bundle, quality ratchets, licences and
secrets. Rust fmt, the CI workspace clippy command, workspace test compilation
and **all 13 backend gates** pass; file-size measures **2,420 files / 297 pins /
zero violations**. No generated baseline changed. The range secrets scan covers
the complete rebased lane. All commits retain Jason Lee's attribution only.

The focused DB suites pass **27 PostgreSQL tests plus 3 helper tests**: inbox
journeys (excluding the unchanged 2,000-person scale case), grants, people,
resilience, native Workbench, the two request regressions, MVP routes, period
unlock decisions and HR change requests/answers. Native Workbench's support and
dispatch fixtures run with `workspace,support,dispatch`; compiling those modules
out intentionally removes their source rows. The unnecessary scale rerun was
stopped during fixture creation; this round makes no new latency claim.

Chromium's root retry is **3/3** green; all ten retry routes, statutory, the 390 px
rail/axe check, solo first-run and two-tab SSE removal pass. J5 passes separately
with `--project=clock --no-deps`. The combined run has **15 passes / 1 existing
skip / 1 failure** at the already-reported `setup-truth.spec.ts:180` layout
assertion, before reaching Home. The isolated full setup-truth rerun is **2/2**
green; the pre-fix layout comparison is also **2/2** green. Keep that intermittent
layout result visible in merge-result verification. Full DB/browser sweeps and
mutation runs remain release-batch checks.

Round-5 files outside the original owned paths:

- `apps/web/src/ui/setup-rail/setup-rail.module.css` — narrow setup actions.
- `backend/app/src/lifecycle/inbox.rs` — unlock display title.
- `backend/crates/hr/adapter-postgres/src/requests/inbox.rs` — current subject name.
- `backend/app/tests/inbox_journey.rs`, `backend/app/tests/inbox_people_journey.rs` — display-title contract.
- `backend/app/tests/workbench_inbox_requests.rs` — consumer regression tests.
- `e2e/read-retry-bound.spec.ts`, `e2e/ideal-first-run-rail.spec.ts` — retry and narrow-rail verification.
- `docs/product/action-inbox.md` — integration evidence and scope inventory.

## Next ownership slice

Source relocation is deferred to keep the permission/record behavior verifiable in
this delivery. Move these exact adapters through their owning services, preserving
the current visibility, failure, cursor and audit contracts:

- `backend/app/src/action_inbox/sources/org_change.rs` → orgchange adapter.
- `backend/app/src/action_inbox/sources/hr_exit.rs`, `hr_lifecycle.rs`,
  `hr_register.rs`, `hr_requests.rs`, `hr_insurance.rs`, `hr_followups.rs` → HR adapter.
- `backend/app/src/action_inbox/sources/setup.rs` → onboarding adapter.
- `backend/app/src/action_inbox/sources/grants.rs` → access adapter.
- `backend/app/src/lifecycle/inbox.rs` with the existing `unlock_decision.rs`
  second-person seam → the owning period-lock read service.

The app remains the composition root. The optimized filing read already lives in
HR and reuses the statutory panel's assessment, scope, placement and access audit.
Birthday-derived filings use the existing projected-key read rather than the raw
source timestamp. No legal deadline or approval chain was introduced as a literal.

## Per-verb parity (Round 2)

The item-kind table above describes membership. This table separately preserves what
an account could do from Home on `5b15c3a8`; no browser source queues are rebuilt.

| Base verb | Current Home verb | Regression proof |
| --- | --- | --- |
| Approve the next pending step in one press | Server `context.command=approve`; same decision endpoint, disabled while its step refreshes | `inbox-command.test.tsx` approval + stale-step cases; OrgChange source DB test |
| Review / reject with a memo | Same organization-change record link beside approval | `inbox.test.ts` server-command wiring cases |
| Effectuate a due change | Server `effectuate` command; fresh headcount read before opening, same consequence snapshot in row/dialog | `inbox-command.test.tsx` confirmation and four headcount guards |
| Edit / redraft / settle own change | Same record and contextual action label | `inbox.test.ts` resolving-record cases |
| Inspect durable outcome while waiting | `context.command_id` outcome link | `inbox.test.ts` durable-outcome case |
| Inspect scheduled change | Scheduled record link; next three scheduled records on empty turn | `inbox.test.ts` scheduled and empty-turn cases |
| HR / HQ confirm, prepare exit settlement | Exit record with the matching action selected | `inbox.test.ts` three exit action cases |
| Review failure, identity, branch, register | Employee record plus corresponding filtered directory | `inbox.test.ts` four filtered-directory cases; `home_queue.rs` |
| Renew contract | Employee record with renewal sheet selected | `inbox.test.ts` contract case; `inbox_journey.rs` renewal window |
| Review change request | Same selected request beside its list | `inbox.test.ts` request case; `inbox_people_journey.rs` |
| Prepare statutory filing | Same lifecycle event in statutory panel | `inbox.test.ts` statutory case; `inbox_people_journey.rs` |
| Decide period unlock | Same selected lock/request, with pre-authorization before DB access | `inbox.test.ts` period case; `lifecycle::inbox` guard and unlock journey |
| Confirm a grant notice | Role, named scope, start/end, state, domain/levels before confirmation; ops skipped | `inbox.test.ts` disclosure; grants source scheduled-scoped test; `inbox_grants_journey.rs` ops/confirmation |
| Register second passkey inline | Existing `AddPasskey`, refreshes inbox and restores focus | `add-passkey.test.tsx`; `inbox.test.ts` account-security case |
| Switch views with counts | Server counts for every usable filter; inexact counts show `+` | `filter.rs` count predicates; `inbox.test.ts`; `inbox_resilience.rs` |
| Start employee registration, import, org work, invite on an empty day | Same four authorized quick starts, from server capability metadata | `inbox.test.ts`; `inbox_resilience.rs` |
| Open own account without work grants | Honest no-work page and account link; no dead filters | `inbox.test.ts`; `home-truth.spec.ts` governance/people-self regression |
| Retry a failed part while using healthy work | Named source outage, support reference and same-endpoint retry; no browser queue merge | `resilience.rs` every source; `inbox_resilience.rs`; `home-truth.spec.ts` governance-32 |
| Read current-as-of time | Database snapshot instant above the queue | `inbox.test.ts`; `inbox_resilience.rs` |
| Finish setup | Same authorized rail, first painted after checklist/reference reads settle; later SSE remains live | `home-screen.test.tsx`; `live.spec.ts:118` |

`action_inbox.source_concurrency` is a read-only process setting (default four),
overridable by `CONSOLE_ACTION_INBOX_SOURCE_CONCURRENCY` within registry bounds.
One semaphore is shared by all inbox and Workbench requests in an API process;
its source-future capacity is capped below the actual runtime pool size. This
does not reserve connection leases: source/audit handoff can briefly retain more
than one lease per permit. A settings-owned reserved floor plus validation of
small runtime-pool plans remains a follow-up.
The scale test measures actual pool leases and acquisitions as well as API latency.
SQLx returns completed connections asynchronously, so leases can briefly exceed the
number of active source futures. Six parallel reads must still let a separate
identity request finish within the same pool's acquire timeout after fan-out starts.
Counts and scheduled previews come from the same admitted source traversal. Bounded
source pages keep their counts inexact; the UI never reports these prefixes as exact.

## Round 2 local evidence

On this machine the combined lane-DB scenario created 2,000 people through the
product API, then measured 20 first-page API reads: p95 **173.2825 ms**, source
concurrency **4**, peak single-request pool leases **7/8**, **400** acquisitions.
Three rounds of six parallel inbox reads peaked at **8/8** leases; the unrelated
identity request, started after source fan-out, completed in **213.9 / 229.1 /
220.6 ms**, within the pool's 1,000 ms acquire timeout. Keyset traversal excluded
the later insert and visited every admitted personnel record once.

The same scale regression on starting tip `91127130` measured **312.708583 ms** and
**8/8** single-request leases, and failed the pool-cap assertion. Other fail-before
proofs in the disposable base worktree: **22** web assertions fail; the grant
journey fails on absent disclosure; the partial-source journey returns **500**;
the capability/count metadata assertions fail. Focused mutation proofs kill the
source-exclusion, deadline, failure-kind, ops-notice and period-unlock pre-guard mutations.
The standing-text pin is regenerated for the restored facts and verbs: **63**,
still below train/fix-r1's **234** (dev **248**). No original capability is
removed to meet the earlier, incomplete implementation's **52**-block pin.
The org command stays in its owning feature; the route composes it and inline
passkey registration into Home. Grant scope text uses the shared access reference
formatter without requiring a separate organization-tree read.
The lane evidence directory is `lanes/eco-g2-inbox/round2-logs/`.

## Round 4 integration

Rebased the lane onto public/dev `9004241bc` (composer #38, including G5 #37 and
REG-a #32). The J5 resolution retains dev's HQ hint and composer verbs plus the
lane's reason/confirmer assertions. The file-size baseline was reconciled by hand;
no baseline generator was run and no contribution file was removed.

`backend/app/src/lib.rs` declares `pub mod action_inbox` without a workspace gate.
`action_inbox.rs` declares its HR/Org/setup/grant sources without that gate, and
`routes/mod.rs` mounts the inbox before the optional workspace mount. The legacy
sources retain their own module gates. The explicit `--no-default-features
--features mvp` build and the MVP-only inbox DB journeys are the release proof.
The ordinary Home route compiles into the web production build and uses the same
endpoint; G1 and SHIP-a can contribute their Home work through this source seam.

Unlock, insurance, lifecycle and request machine values live in typed context;
`ref` is empty for these kinds. Home uses the period/domain presenters, reason
catalog presentation, enum labels and statutory catalog keys. Unlock rows retain
the requester, period, relock deadline, reason/note and subject-named review link.
Tenant-defined unlock reasons carry their catalog labels; unknown reason codes
render a readable unknown label. BW-17 also accepts prose in `reason_code`, which
remains readable. The request has its own review verb.

Both Home inbox observers request `refetchOnMount: "always"`; navigation after an
import waits for the new inbox snapshot. The statutory journey asserts all four
labelled filing rows and their resolving links. The E2E audit also migrated the
remaining removed Home reads/sections in parity, org, bounded-retry, access and
capture callers. Cursor parity compares against the complete queue, including
setup work, and observes `total_is_exact` rather than treating a prefix as exact.

G5's person projections now supply the inbox's person facts and statutory query;
the inherited person-read inventory only shrinks. The combined settings roster is
regenerated in `20261024000000000_inbox_settings_after_import.sql`, because the
newer import migration otherwise replaces the earlier inbox definitions.

Round-4 command logs are in `lanes/eco-g2-inbox/round4-logs/`. The disposable
`fail-before-r4` worktree starts at rebased pre-fix `aab733a63`; the new row-content
and mount-refresh assertions fail there, while the current focused tests pass.
The unlock/request/lifecycle DB assertions also fail before their source fixes.
Additional before-fix tests cover tenant reason labels and free-text reasons.

The exact CI web command passes in the isolated proof clone with public dev as
its `dev` branch: **281 files / 1,985 Vitest tests**, the production build and
bundle gate, history/build secrets scans, headers, fixture IDs, licences and
**3 Node tests**. `VITEST_MAX_WORKERS=2` limits local contention; earlier uncapped
runs hit unrelated five-second test timeouts. No test timeout was changed.
The sandboxed browser launch also failed on macOS Mach-port permissions; the
successful browser-backed unit run used the approved host execution.

Rust fmt, workspace clippy with `-D warnings`, workspace test compilation, the
explicit MVP build and **all 13 CI-discovered backend release gates** pass.
The file-size gate measures **2,415 Rust files / 297 pins**; the app inbox API pin
is manually lowered to **1,120** after the G5 merge. The composer standing-text
contribution is lowered from **216 to 63**, preserving the lane's existing pin.
The person-read inventory falls to **56**. Range gitleaks reports no leaks.

Touched/dependent crate checks pass: settings-domain + action-inbox-application +
identity-rest **170 tests**; MVP app library **137 passed / 1 pre-existing ignored**;
HR statutory/person **12**; period/person projection DB **9**; HR REST/settings
adapter **24**; entity REST **5**; MVP surfaces **2**; route layers **3**; the
additional tenant-labelled unlock DB rerun **1**. The focused Home/route/command
suite has **72 passing tests**. In the rebased starting worktree, **10 of 61**
Home/route assertions fail; the other 51 pass.

All **13 inbox DB journeys** pass in the MVP build. For **2,000 product-created
people / 20 first-page reads**, p95 is **222.974167 ms** (budget 300 ms), peak
single-request leases **7/8**, source cap **4**, and **400** acquisitions. The
inserted-later person stays outside the cursor traversal, which visits each
admitted person once. Three six-reader rounds peak at **8/8** leases; unrelated
identity reads finish in **264.405292 / 252.082833 / 246.391917 ms**. Pool headroom
under concurrent reads remains the already-recorded P2 follow-up.

The requested combined Chromium command could not start the webServer because
this checkout has no `ops/compose.yml`; zero E2E assertions ran. The verifier must
run J5, d26, period-unlock-approve, ideal-first-run-rail, statutory, home-truth and
inbox-live in its compose environment, plus the additionally migrated parity/org/
retry/access journeys. Full workspace DB, Firefox and mutation sweeps remain the
release batch's checks.

## Change inventory

This is the complete lane inventory against public/dev `9004241bc`, including
deletions and generated contracts. No excluded lane file is edited. Shared
contracts are regenerated with the repository OpenAPI and TypeScript generators.

### Owned paths

- `apps/web/src/features/home/Home.tsx`
- `apps/web/src/features/home/api.test.ts`
- `apps/web/src/features/home/api.ts`
- `apps/web/src/features/home/domain/coverage.test.ts`
- `apps/web/src/features/home/domain/coverage.ts`
- `apps/web/src/features/home/domain/lanes.test.ts`
- `apps/web/src/features/home/domain/lanes.ts`
- `apps/web/src/features/home/ui/change-rows.test.tsx`
- `apps/web/src/features/home/ui/change-rows.tsx`
- `apps/web/src/features/home/ui/coverage-notice.tsx`
- `apps/web/src/features/home/ui/grant-notices.tsx`
- `apps/web/src/features/home/ui/inbox.test.ts`
- `apps/web/src/features/home/ui/no-work.tsx`
- `apps/web/src/features/home/ui/people-rows.tsx`
- `apps/web/src/features/home/ui/queue-empty.tsx`
- `apps/web/src/features/home/ui/quiet-queue.tsx`
- `apps/web/src/features/home/ui/request-queue.tsx`
- `apps/web/src/features/home/ui/unlock-queue.tsx`
- `backend/app/Cargo.toml`
- `backend/app/src/action_inbox.rs`
- `backend/app/src/action_inbox/legacy.rs`
- `backend/app/src/action_inbox/response.rs`
- `backend/app/src/action_inbox/sources/audit_personnel.rs`
- `backend/app/src/action_inbox/sources/grants.rs`
- `backend/app/src/action_inbox/sources/hr_exit.rs`
- `backend/app/src/action_inbox/sources/hr_followups.rs`
- `backend/app/src/action_inbox/sources/hr_insurance.rs`
- `backend/app/src/action_inbox/sources/hr_lifecycle.rs`
- `backend/app/src/action_inbox/sources/hr_lifecycle_tests.rs`
- `backend/app/src/action_inbox/sources/hr_register.rs`
- `backend/app/src/action_inbox/sources/hr_requests.rs`
- `backend/app/src/action_inbox/sources/mod.rs`
- `backend/app/src/action_inbox/sources/org_change.rs`
- `backend/app/src/action_inbox/sources/setup.rs`
- `backend/app/src/action_inbox/workbench.rs`
- `backend/app/src/action_inbox/workflow.rs`
- `backend/app/src/routes/mod.rs`
- `backend/app/src/routes/workflow.rs`
- `backend/app/tests/action_inbox/governance.rs`
- `backend/crates/action-inbox/application/Cargo.toml`
- `backend/crates/action-inbox/application/src/complete.rs`
- `backend/crates/action-inbox/application/src/filter.rs`
- `backend/crates/action-inbox/application/src/lib.rs`
- `backend/crates/action-inbox/application/src/namespaced_id.rs`
- `backend/crates/action-inbox/application/src/source.rs`
- `backend/crates/action-inbox/application/tests/home_queue.rs`
- `backend/crates/action-inbox/application/tests/resilience.rs`

### Shared contract paths

- `backend/openapi/openapi.yaml`
- `packages/api/src/schema.d.ts`
- `packages/i18n/src/catalogs/en/home.ts`
- `packages/i18n/src/catalogs/ko/home.ts`

### Outside owned paths

- `apps/web/src/features/account/ui/second-passkey.tsx`
- `apps/web/src/features/onboarding/ui/add-passkey.test.tsx`
- `apps/web/src/features/onboarding/ui/add-passkey.tsx`
- `apps/web/src/features/org/OrgChange.tsx`
- `apps/web/src/features/org/ui/effectuate-consequence.tsx`
- `apps/web/src/features/org/ui/inbox-command.test.tsx`
- `apps/web/src/features/org/ui/inbox-command.tsx`
- `apps/web/src/features/people/Employee.tsx`
- `apps/web/src/features/people/api.ts`
- `apps/web/src/lib/live/live.test.ts`
- `apps/web/src/lib/live/live.ts`
- `apps/web/src/lib/live/topics.test.ts`
- `apps/web/src/lib/live/topics.ts`
- `apps/web/src/reference/authz/present.test.ts`
- `apps/web/src/reference/authz/present.ts`
- `apps/web/src/reference/org/present.ts`
- `apps/web/src/reference/periods/api.ts`
- `apps/web/src/routes/home-screen.test.tsx`
- `apps/web/src/routes/home-screen.tsx`
- `apps/web/src/ui/setup-rail/setup-rail.module.css`
- `backend/Cargo.lock`
- `backend/app/src/config/db_pool.rs`
- `backend/app/src/lib.rs`
- `backend/app/src/lifecycle.rs`
- `backend/app/src/lifecycle/inbox.rs`
- `backend/app/src/routes/surfaces.rs`
- `backend/app/src/workbench_native.rs`
- `backend/app/tests/action_inbox_api.rs`
- `backend/app/tests/inbox_grants_journey.rs`
- `backend/app/tests/inbox_journey.rs`
- `backend/app/tests/inbox_people_journey.rs`
- `backend/app/tests/inbox_pool/mod.rs`
- `backend/app/tests/inbox_resilience.rs`
- `backend/app/tests/workbench_inbox_requests.rs`
- `backend/ci/gates/file-size/baseline.txt`
- `backend/crates/hr/adapter-postgres/src/requests/inbox.rs`
- `backend/crates/hr/adapter-postgres/src/statutory/filing_query.rs`
- `backend/crates/hr/adapter-postgres/src/statutory/filings.rs`
- `backend/crates/hr/adapter-postgres/src/statutory/types.rs`
- `backend/crates/hr/adapter-postgres/tests/statutory_age.rs`
- `backend/crates/hr/adapter-postgres/tests/statutory_scale.rs`
- `backend/crates/identity/rest/openapi/paths/api__v1__me__action-inbox.get.yaml`
- `backend/crates/identity/rest/openapi/schemas/AccessScope.yaml`
- `backend/crates/identity/rest/openapi/schemas/ActionInboxItem.yaml`
- `backend/crates/identity/rest/openapi/schemas/ActionInboxResponse.yaml`
- `backend/crates/identity/rest/src/openapi.rs`
- `backend/crates/platform/db/migrations/20261022220000000_inbox_contract_reminder_setting.sql`
- `backend/crates/platform/db/migrations/20261022220000001_inbox_account_live.sql`
- `backend/crates/platform/db/migrations/20261023000000000_inbox_read_budget.sql`
- `backend/crates/platform/db/migrations/20261024000000000_inbox_settings_after_import.sql`
- `backend/crates/platform/realtime/src/filter.rs`
- `backend/crates/settings/domain/src/keys/display.rs`
- `backend/crates/settings/domain/src/keys/perf.rs`
- `backend/crates/settings/domain/tests/registry.rs`
- `backend/crates/settings/domain/tests/sql_definitions.rs`
- `docs/product/action-inbox.md`
- `e2e/d26-solo-exit.spec.ts`
- `e2e/home-truth.spec.ts`
- `e2e/ideal-first-run-access.spec.ts`
- `e2e/ideal-first-run-rail.spec.ts`
- `e2e/import-reds-layout.spec.ts`
- `e2e/inbox-live.spec.ts`
- `e2e/j3-renewal.spec.ts`
- `e2e/j5-exit.spec.ts`
- `e2e/live.spec.ts`
- `e2e/org.spec.ts`
- `e2e/parity-regressions.spec.ts`
- `e2e/parity/states.capture.ts`
- `e2e/parity/walk-1011.capture.ts`
- `e2e/parity/walk-1012.capture.ts`
- `e2e/parity/walk.capture.ts`
- `e2e/period-unlock-approve.spec.ts`
- `e2e/read-retry-bound.spec.ts`
- `e2e/setup-truth.spec.ts`
- `e2e/statutory.spec.ts`
- `packages/i18n/src/catalogs/d26-copy.test.ts`
- `packages/i18n/src/catalogs/en/requests.ts`
- `packages/i18n/src/catalogs/ko/requests.ts`
- `scripts/check-source.mjs`
- `scripts/ds-baseline.json`
- `scripts/person-reads-baseline.json`
- `scripts/quality/baseline.json`
- `scripts/reach-baseline.json`
- `scripts/standing-text-baseline.json`
- `scripts/standing-text.d/eco-composer.json`

## Round 6 support integration

Rebased all fourteen existing lane commits, including the Workbench test feature
declarations, onto public/dev `4a91b18dd` (G1 support, PR #42). The combined inbox
registers nineteen sources. G1's SupportAccess adapter remains release-mounted,
uses the expanded source query and carries an absent typed context. Its catalog
permission also supplies the queue's capability and filter metadata, including
for a support-only approver with no pending request. Home keeps the localized
support source label and selected review link alongside G2's typed decision rows.

The first combined full-feature scale run met the latency budget (194 ms p95)
but occupied all eight pool leases; the starting G2 tip passed the same full
case at 223 ms and seven leases. Source admission now budgets for both an active
SQLx lease and its asynchronous return, plus one spare pool connection. It still
obeys the settings-owned source ceiling: an eight-connection pool admits three
sources, while larger pools retain the configured four. The observer uses the
same effective bound. A small lazy-pool test covers constrained, ordinary and
single-connection pools, and a lower configured ceiling. Refused support reads
finish their read transaction before releasing their source slot.

The generated contract documents thirty-nine extensible item kinds and retains
G2's typed unlock, insurance, lifecycle and request contexts. The latest settings
function was regenerated from the combined ninety-eight-key roster. The reach
generator produces fifty-two record gaps and 160 operation allowances, down from
G2's 164 and G1's 161; every remaining allowance already belonged to one side.
The file-size generator folds the existing G1 and access-log contributions into
the main baseline and consumes their contribution files: 294 pins, no violations
and no increases against public/dev. All thirteen backend release gates pass.

Two support-row web regressions fail in the detached pre-fix worktree
`lanes/eco-g2-inbox/fail-before-r6` at `476055454`, then pass on the merged tip.
The existing support-approval DB journey also fails there on `has_work=false`
when its new assertion is applied with only the source-query/context compilation
compatibility changes; it passes with the metadata integration. The inherited
API compatibility test rejects the closed kind enum before regeneration.

Additional files outside the original owned paths this round:

- `backend/app/src/action_inbox/sources/support_access.rs` — adapt G1 to the shared query/context and retain its authorization metadata.
- `backend/app/tests/action_inbox/support_access.rs` — support-only capability regression.
- `scripts/api-compat.test.ts` — retain all thirty-nine documented extensible kinds.
- `e2e/support-access.spec.ts` — scope the queue and safety-notice review links separately and prove both share the selected record.
- `backend/ci/gates/file-size/baseline.d/eco-g1-support.txt` — consumed by the baseline generator.
- `backend/ci/gates/file-size/baseline.d/rv-SEC-K1-c-access-log-legal-hold.txt` — consumed by the baseline generator.

The earlier change inventory also covers this round's generated contracts,
settings migration/registry, and size/reach baselines. No excluded file changed.
Logs are in `lanes/eco-g2-inbox/round6-logs/`.

### Final round-6 proof

The final base is public/dev `dc2fb6ebe` (#44), after G1's `4a91b18dd` (#42).
The later upstream change only adjusts `e2e/registration-void.browser.ts`'s
browser-test budget; the backend tree is identical across that final rebase.

The exact web CI pipeline passes in `lanes/eco-g2-inbox/ci-proof-r6`, with its
`dev` branch at the public base: **291 Vitest files / 2,087 tests**, **3 Node
tests**, typecheck, lint, production build/bundle, secrets, headers, fixture IDs
and licences. The isolated clone avoids the shared checkout's unrelated private
`dev` ref; no check script or timeout was changed.

Rust fmt, workspace all-target clippy, workspace test clippy, workspace test
compilation and full/test-postgres app clippy pass with warnings denied. All
**13** CI-discovered backend gates pass. The focused Rust runs pass **267 test
executions**, including both feature presets where the release boundary matters:

| Suite | Passing cases |
| --- | ---: |
| Settings domain and inbox application | 71 |
| Identity library and OpenAPI contract | 47 |
| HR and entity REST libraries | 9 |
| Support service/ledger DB suites | 26 |
| Settings adapter DB suites | 15 |
| HR request/statutory DB suites | 8 |
| Platform person/period DB suites | 12 |
| Full-feature app inbox/Workbench/support/unlock suites | 51 |
| Full-feature app source/support-reference/unlock libraries | 15 |
| MVP inbox journeys and route boundaries | 12 |
| Small-pool admission regression | 1 |

The full-feature API scale case creates **2,000 people through the product API**
and measures twenty first pages: p95 **166.652833 ms**, peak single-request
leases **5/8**, effective source cap **3**, **560** acquisitions. Its insert
admission and cursor traversal assertions pass. Three rounds of six parallel
inbox readers peak at **8/8**, while unrelated identity reads finish in
**107.177167 / 107.071416 / 105.0395 ms**, within their one-second budget.
The measurement assertion stays at 300 ms and the single-request reserve
assertion remains strict; neither was relaxed.

The new admission test fails in the detached `fail-before-budget-r6` worktree
at pre-fix `dc208dd4a` (four admitted readers where three are required), and
passes with the pool-derived budget. The earlier combined scale failure and
the original-G2 control remain in `round6-logs/db-app.log` and
`round6-logs/scale-original-g2-full.log`.

Chromium's six requested specs were attempted with the slot harness. Startup
stops before any assertion because this public checkout lacks `ops/compose.yml`.
The verifier must run `support-access`, `home-truth`, `inbox-live`,
`read-retry-bound`, `period-unlock-approve` and `first-run-solo`; the support
spec now proves the queue and safety notice point to the same pending request.
The full workspace DB, both-browser E2E and mutation sweeps remain release-batch
checks. No excluded file was changed; the inventory above covers every lane path.
