// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[allow(dead_code)]
mod common;

use console_kernel_core::OrgId;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn confirming_an_exit_invalidates_its_case_and_observed_items_in_the_same_outbox(
    pool: PgPool,
) {
    let org = OrgId::one();
    common::commit(
        &pool,
        org,
        vec![common::event(
            org,
            ("employee_exit_case", &Uuid::new_v4().to_string()),
            "employee.exit.confirm",
            None,
        )],
    )
    .await;
    let changes: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT resource_type,resource_id FROM resource_changes WHERE org_id=$1 \
         AND resource_type IN ('lifecycle_case','lifecycle_case_item') ORDER BY resource_type",
    )
    .bind(org.as_uuid())
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        changes,
        vec![
            ("lifecycle_case".into(), None),
            ("lifecycle_case_item".into(), None)
        ]
    );
}
