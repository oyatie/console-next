// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn machine_kind_fallback_is_not_an_approval_summary(pool: PgPool) {
    let (org, maker, checker) = setup(&pool).await;
    let id = document(&pool, org, maker, "OC-2026-0001").await;
    sqlx::query("UPDATE org_change_requests SET reason=kind WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let ctx = fixtures::ctx(&pool, org, checker, &["EXECUTIVE"], None).await;
    let page = get(&ctx, &format!("box=pending&focus=org_change:{id}")).await;
    assert_eq!(page["items"][0]["summary"], "");
    assert_eq!(page["focused"]["summary"], "");
}
