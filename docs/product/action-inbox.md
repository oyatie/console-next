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
| HR/HQ exit confirmation and settlement | HrExit / hr_exit_confirm, hr_exit_confirm_hq, hr_exit_settle | Exit case at its next action |
| Failed scheduled action | HrLifecycle / lifecycle_apply_failed | Personnel card, failure reason |
| Open correction request | HrRequests / hr_request | Change request selected by id |
| Incomplete statutory register | HrRegister / register_review | Personnel card |
| Identity confirmation | HrIdentity / identity_review | Personnel card |
| Missing home branch | HrBranch / home_branch_review | Personnel card |
| Contract ending in reminder window | HrContract / contract_renewal | Personnel card, renewal sheet |
| Pending insurance filing | HrInsurance / insurance_filing | Statutory filing panel |
| Unlock needing a second person | PeriodUnlock / period_unlock | Period lock, selected request |
| Unconfirmed own grant | GrantNotice / grant_notice | Inline notice confirmation |
| Setup work | Setup / setup_* | Existing authorized setup rail, once inside 업무함 |
| Operating account with one passkey | GrantNotice / account_security | Inline second-passkey registration and account link |

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
its capacity leaves at least one connection below the actual runtime pool size.
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

## Change inventory

The allowlist is `units/ecosystem/briefs/ECO-G2-INBOX.paths.json` in console-handoff.
The paths below are the complete lane inventory against train/fix-r1, including
Round 2. Generated contracts are regenerated with their repository tools.

### Owned and shared contract paths

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
- `backend/openapi/openapi.yaml`
- `packages/api/src/schema.d.ts`
- `packages/i18n/src/catalogs/en/home.ts`
- `packages/i18n/src/catalogs/ko/home.ts`

### Outside owned paths

These supporting route, command, configuration, source-test and contract files are
necessary for the requested parity, pool bound, first-paint and verification proof.
No excluded lane file is edited.

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
- `backend/crates/platform/realtime/src/filter.rs`
- `backend/crates/settings/domain/src/keys/display.rs`
- `backend/crates/settings/domain/src/keys/perf.rs`
- `backend/crates/settings/domain/tests/registry.rs`
- `backend/crates/settings/domain/tests/sql_definitions.rs`
- `docs/product/action-inbox.md`
- `e2e/home-truth.spec.ts`
- `e2e/inbox-live.spec.ts`
- `e2e/live.spec.ts`
- `e2e/setup-truth.spec.ts`
- `packages/i18n/src/catalogs/d26-copy.test.ts`
- `scripts/check-source.mjs`
- `scripts/ds-baseline.json`
- `scripts/quality/baseline.json`
- `scripts/reach-baseline.json`
- `scripts/standing-text-baseline.json`
