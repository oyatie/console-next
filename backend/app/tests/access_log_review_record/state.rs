// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn start_replays_report_completed_state(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "start-state").await;
    reviewer(&pool, org, user).await;
    let service = AccessService::new(runtime_role_pool(&pool).await, None);
    let p = principal(org, user);
    record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "state-start-key-1".into(),
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,trace_id,span_id,occurred_at,after_snap) VALUES($1,$2,'access_log_review.complete','access_log_review','tenant:2026-09',repeat('a',32),repeat('b',16),now(),'{}')")
        .bind(org.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    for key in ["state-start-key-1", "state-start-key-2"] {
        assert_eq!(
            record::start(&service, p.clone(), "2026-09".into(), key.into())
                .await
                .unwrap()["state"],
            "complete"
        );
    }
}
