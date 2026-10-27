// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn batched_identity_keeps_own_record_refused_and_other_people_visible(pool: PgPool) {
    let w = world::World::seed(&pool, &[vec![1, 1]]).await;
    let actor = UserId::from_uuid(w.holder(&pool, Some(NodeKind::Tenant), false, 0).await);
    grant_exit(&pool, w.org, actor).await;
    let units: Vec<_> = w
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Department)
        .map(|n| n.id)
        .collect();
    for unit in &units {
        super::bounded::seed(&pool, w.org, actor, 1, Some(*unit)).await;
    }
    let people: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM employees WHERE org_id=$1 ORDER BY org_unit_id")
            .bind(w.org.as_uuid())
            .fetch_all(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE users SET employee_id=$2 WHERE org_id=$1 AND id=$3")
        .bind(w.org.as_uuid())
        .bind(people[0])
        .bind(actor.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let p = principal(&pool, w.org, actor, false).await;
    let now = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let home = page(
        &runtime_role_pool(&pool).await,
        &p,
        query(now, 20),
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        home.items.len(),
        1,
        "the non-ops actor cannot act on their own record"
    );
    assert!(
        home.items[0]
            .links
            .iter()
            .any(|l| l.kind == "employee" && l.id == people[1].to_string())
    );
}
