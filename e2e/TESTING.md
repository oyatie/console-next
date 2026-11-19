<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

# E2E fixture limits

Build `console-app` with `--features full,e2e-test-support` for the complete suite
and point `CONSOLE_APP_BIN` at that binary. The default MVP profile can run specs
that use its routes. Only the two registration tests in `parity-regressions`
require the workspace action inbox; each fails with build instructions when
that route is unavailable. Global setup allows either profile.

Build synthetic tenants through the product. Pending elevated grants use
`activatePendingGrants`: it moves only that tenant's test worker clock to the
configured deadline. Debug and explicit `e2e-test-support` builds honor the clock;
deployable release builds ignore it. This does not advance
second-person eligibility or its independent `min_grant_age` setting.

Known gaps:

- Before go-live, pending grant confirmations gate second-person eligibility but
  have no product entry point: setup hides the inbox tabs and Home excludes grant
  notices (`f058c5b97b`, `e2ca8c65ae`). `attendance-closed-month.spec.ts`, the sole
  close authority case in `period-unlock-approve.spec.ts`, and
  `account-link-guard.spec.ts` open 참조 by URL through `openGrantNotice`.
  Passing these journeys does not prove setup navigation. The product owner must
  choose a setup entry point; then these callers should navigate through it.

- `org-sole-holder-live.spec.ts` uses `helpers/sole-holder.ts` to bind the sole
  administrator to an employee and natural person through SQL. The product
  forbids self-binding, so this proves approval only after identity binding.
  The first-run solo fallback remains a fixme until a governed self-binding
  path has an owner decision and a backend implementation.

- `second-person-fixture.ts::letGrantsAge` still backdates the grant ledger and
  role-definition timestamps for minimum-age scenarios. It is test-only; replace
  it when the eligibility SQL and authorization readers share the kernel clock.
- `terms-fixture.ts` supplies the synthetic terms document outside the product
  because tenant users cannot publish platform terms.

DB suites and browser execution for lane F8 run in the external verifier. The
capacity test emits its measured microseconds; set
`CONSOLE_TEST_GRANT_INTEGRITY_BUDGET_MS` to the agreed release budget to enforce
that threshold. An emitted measurement alone does not establish readiness.
