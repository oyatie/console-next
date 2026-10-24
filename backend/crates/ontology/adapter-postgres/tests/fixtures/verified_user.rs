// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;
#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

pub(crate) async fn seed_org_and_user(pool: &PgPool, org: Uuid, tag: &str) -> UserId {
    let user = console_platform_test_support::seed_org_and_super_admin(pool, org, tag).await;
    person_fixtures::bind_user_to_distinct_person(pool, user).await;
    user
}
