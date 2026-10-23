<!-- SPDX-License-Identifier: LicenseRef-Proprietary -->

# E2E fixture limits

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
