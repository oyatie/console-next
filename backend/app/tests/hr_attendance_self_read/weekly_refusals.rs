// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unavailable_weekly_policy_is_internal_and_never_a_write_conflict(pool: PgPool) {
    let keys = keys();
    let member = UserId::new();
    seed_linked_employee(&pool, member, "MEMBER", "weekly-refusal").await;
    let service =
        build_router(app_state(runtime_role_pool(&pool).await, keys.public_pem.clone()).unwrap());
    let token = bearer(&pool, &keys, member, "MEMBER").await;
    for corrupt in [
        "UPDATE statutory_rules SET unit='DAYS' WHERE code='WEEKLY_STANDARD_HOURS'",
        "REVOKE SELECT ON lifecycle_statutory_rules FROM console_rt",
    ] {
        let saved: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(r)) FROM statutory_rules r WHERE code='WEEKLY_STANDARD_HOURS'").fetch_one(&pool).await.unwrap();
        sqlx::query(corrupt).execute(&pool).await.unwrap();
        let response = get(
            service.clone(),
            &format!("{MY_WEEK52_PATH}?week_start=2026-10-26"),
            &token,
        )
        .await;
        assert_eq!(
            response.status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{:?}",
            response.json
        );
        assert_eq!(response.json["error"]["code"], "internal");
        sqlx::query("GRANT SELECT ON lifecycle_statutory_rules TO console_rt")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM statutory_rules WHERE code='WEEKLY_STANDARD_HOURS'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO statutory_rules SELECT * FROM jsonb_populate_recordset(NULL::statutory_rules,$1)").bind(saved).execute(&pool).await.unwrap();
    }
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,effective_from,set_by,reason_code,direction) VALUES($1,'attendance.week52.warn_hours','\"broken\"','2026-10-01',$2,'X','tighten')")
        .bind(OrgId::one().as_uuid()).bind(member.as_uuid()).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let response = get(
        service,
        &format!("{MY_WEEK52_PATH}?week_start=2026-10-26"),
        &token,
    )
    .await;
    assert_eq!(
        response.status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "{:?}",
        response.json
    );
    assert_eq!(response.json["error"]["code"], "internal");
}
