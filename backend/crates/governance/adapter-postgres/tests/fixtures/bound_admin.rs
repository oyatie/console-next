// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;
#[path = "../../../../../test-support/person_fixtures.rs"]
mod person_fixtures;

pub(super) async fn seed_user(pool: &PgPool, org: Uuid, name: &str) -> UserId {
    let user =
        console_platform_test_support::seed_active_user(pool, org, "SUPER_ADMIN", name).await;
    person_fixtures::bind_user_to_distinct_person(pool, user).await;
    user
}
