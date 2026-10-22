<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->
# One 업무함 (ECO-G2)

Home reads `GET /api/v1/me/action-inbox` for work. The server owns membership,
permissions, the five saved filters and immutable keyset traversal. A failed source
fails the read; a bounded count says `total_is_exact: false`. Source deadlines
produce calendar-day D-n on the database clock. Statutory dates use the statutory
register, and the renewal horizon uses `hr.contract_soon_days`.

## Home parity

| Former Home work | Server source / item kind | Resolving destination |
| --- | --- | --- |
| Approval by another drafter | OrgChange / org_change_approve | Organization change, review |
| Own draft or prechecked change | OrgChange / org_change_draft | Organization change, edit |
| Rejection awaiting redraft | OrgChange / org_change_rejected | Organization change, rejection |
| Settlement after application | OrgChange / org_change_settle | Organization change, settle |
| Due approved change | OrgChange / org_change_apply | Organization change, apply |
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
| Operating account with one passkey | GrantNotice / account_security | Account, add a passkey |

The OrgChange and HrExit DB source tests cover each state and denial. The release
journey tests cover setup, identity, branch, renewal policy, grant notices, unlocks,
refused readers, the synthetic 2,000-person API workload and cursor admission under
inserts. Existing action-inbox API tests retain legacy-source authorization and RLS
proof. Web tests cover filters, pages, deadlines and refresh; inbox E2E covers actual
two-tab resolution, axe, both themes and desktop/mobile widths.

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

## Change inventory

The brief does not enumerate an `owns` allowlist. The complete touched-file inventory
(including supporting callers, contracts, migrations, catalogs and ratchets) is below;
no excluded lane file is edited. Deleted obsolete Home queue files are included.

- `apps/web/src/features/account/ui/second-passkey.tsx`
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
- `apps/web/src/features/home/ui/request-queue.tsx`
- `apps/web/src/features/home/ui/unlock-queue.tsx`
- `apps/web/src/features/org/OrgChange.tsx`
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
- `apps/web/src/routes/home-screen.tsx`
- `backend/Cargo.lock`
- `backend/app/Cargo.toml`
- `backend/app/src/action_inbox.rs`
- `backend/app/src/action_inbox/legacy.rs`
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
- `backend/app/src/lib.rs`
- `backend/app/src/lifecycle.rs`
- `backend/app/src/lifecycle/inbox.rs`
- `backend/app/src/routes/mod.rs`
- `backend/app/src/routes/surfaces.rs`
- `backend/app/src/routes/workflow.rs`
- `backend/app/tests/inbox_journey.rs`
- `backend/ci/gates/file-size/baseline.txt`
- `backend/crates/action-inbox/application/Cargo.toml`
- `backend/crates/action-inbox/application/src/complete.rs`
- `backend/crates/action-inbox/application/src/filter.rs`
- `backend/crates/action-inbox/application/src/lib.rs`
- `backend/crates/action-inbox/application/src/namespaced_id.rs`
- `backend/crates/action-inbox/application/src/source.rs`
- `backend/crates/action-inbox/application/tests/home_queue.rs`
- `backend/crates/hr/adapter-postgres/src/requests/inbox.rs`
- `backend/crates/hr/adapter-postgres/src/statutory/filing_query.rs`
- `backend/crates/hr/adapter-postgres/src/statutory/filings.rs`
- `backend/crates/hr/adapter-postgres/src/statutory/types.rs`
- `backend/crates/hr/adapter-postgres/tests/statutory_age.rs`
- `backend/crates/hr/adapter-postgres/tests/statutory_scale.rs`
- `backend/crates/identity/rest/openapi/paths/api__v1__me__action-inbox.get.yaml`
- `backend/crates/identity/rest/openapi/schemas/ActionInboxItem.yaml`
- `backend/crates/identity/rest/openapi/schemas/ActionInboxResponse.yaml`
- `backend/crates/platform/db/migrations/20261022220000000_inbox_contract_reminder_setting.sql`
- `backend/crates/platform/db/migrations/20261022220000001_inbox_account_live.sql`
- `backend/crates/platform/realtime/src/filter.rs`
- `backend/crates/settings/domain/src/keys/display.rs`
- `backend/crates/settings/domain/tests/registry.rs`
- `backend/crates/settings/domain/tests/sql_definitions.rs`
- `backend/openapi/openapi.yaml`
- `docs/product/action-inbox.md`
- `e2e/home-truth.spec.ts`
- `e2e/inbox-live.spec.ts`
- `e2e/live.spec.ts`
- `packages/api/src/schema.d.ts`
- `packages/i18n/src/catalogs/d26-copy.test.ts`
- `packages/i18n/src/catalogs/en/home.ts`
- `packages/i18n/src/catalogs/ko/home.ts`
- `scripts/check-source.mjs`
- `scripts/ds-baseline.json`
- `scripts/quality/baseline.json`
- `scripts/reach-baseline.json`
- `scripts/standing-text-baseline.json`
