<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

# E2E fixture limits

Build `console-app` with `--features full,e2e-test-support` for the complete suite
and point `CONSOLE_APP_BIN` at that binary. The default MVP profile can run specs
that use its routes. Only the two registration tests in `parity-regressions`
require the workspace action inbox; each fails with build instructions when
that route is unavailable. Global setup allows either profile.

Build synthetic tenants through the product. Pending elevated grants use
`activatePendingGrants`: it moves only that tenant's debug worker clock to the
configured deadline. Release builds ignore this clock. This does not advance
second-person eligibility or its independent `min_grant_age` setting.

Known gaps:

- `second-person-fixture.ts::letGrantsAge` still backdates the grant ledger and
  role-definition timestamps for minimum-age scenarios. It is test-only; replace
  it when the eligibility SQL and authorization readers share the kernel clock.
- `terms-fixture.ts` supplies the synthetic terms document outside the product
  because tenant users cannot publish platform terms.

DB suites and browser execution for lane F8 run in the external verifier. The
capacity test emits its measured microseconds; set
`CONSOLE_TEST_GRANT_INTEGRITY_BUDGET_MS` to the agreed release budget to enforce
that threshold. An emitted measurement alone does not establish readiness.
