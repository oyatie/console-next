// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{OrgId, UserId};
use sqlx::PgPool;

#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

#[path = "../../../rest/tests/fixtures/pay_view.rs"]
mod pay_access;

/// A person-bound account with tenant pay:edit, which submit and decide need, as over REST.
pub(crate) async fn bind_pay_editor(owner_pool: &PgPool, org: OrgId, user: UserId) {
    person_fixtures::bind_user_to_distinct_person(owner_pool, user).await;
    pay_access::grant_manage(owner_pool, org, user, None).await;
}
