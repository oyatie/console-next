// SPDX-License-Identifier: LicenseRef-Proprietary
//! Commands that `execute_action` dispatches to a canonical port and the port refuses.
use super::*;

#[path = "../../../../payroll/rest/tests/fixtures/pay_view.rs"]
mod pay_view;

mod company_fact_refusal;
mod pay_run_clearance;

/// A person-bound account with tenant pay:edit, which submit and decide need, as over REST.
pub(super) async fn bind_pay_editor(owner: &PgPool, org: OrgId, user: UserId) {
    person_fixtures::bind_user_to_distinct_person(owner, user).await;
    pay_view::grant_manage(owner, org, user, None).await;
}
