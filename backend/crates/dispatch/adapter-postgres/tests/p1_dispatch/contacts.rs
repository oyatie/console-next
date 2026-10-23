// SPDX-License-Identifier: LicenseRef-Proprietary
use super::seed_dispatch_context;
use console_dispatch_adapter_postgres::PgDispatchStore;
use console_dispatch_application::{
    ExpireP1DispatchCommand, ForceAssignP1DispatchCommand, StartP1DispatchCommand,
};
use console_dispatch_domain::DispatchTimerConfig;
use console_kernel_core::{OrgId, TraceContext};
use sqlx::PgPool;
use time::macros::datetime;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_identical_force_assignment_replays_once(pool: PgPool) {
    console_platform_request_context::scope_org(OrgId::one(), async move {
        let seeded = seed_dispatch_context(&pool).await;
        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);
        let started = store.start_dispatch(StartP1DispatchCommand { actor: seeded.receptionist, work_order_id: seeded.work_order_id, incident_location: None, include_region: false, trace: TraceContext::generate(), occurred_at: now }, DispatchTimerConfig::default()).await.unwrap();
        store.expire_accept_window(ExpireP1DispatchCommand { dispatch_id: started.id, trace: TraceContext::generate(), occurred_at: now + time::Duration::minutes(6) }).await.unwrap();
        let command = ForceAssignP1DispatchCommand { actor: seeded.manager, dispatch_id: started.id, mechanic_id: seeded.far_mechanic, trace: TraceContext::generate(), occurred_at: now + time::Duration::minutes(7) };
        let (left, right) = tokio::join!(store.force_assign(command.clone()), store.force_assign(command));
        assert_eq!(left.unwrap().id, right.unwrap().id);
        let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE action = 'p1_dispatch.force_assign' AND target_id = $1").bind(started.id.to_string()).fetch_one(&pool).await.unwrap();
        assert_eq!(audits, 1);
    }).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn delivery_uses_the_account_contact_instead_of_the_person_phone(pool: PgPool) {
    console_platform_request_context::scope_org(OrgId::one(), async move {
        let seeded = seed_dispatch_context(&pool).await;
        let ids = vec![*seeded.near_mechanic.as_uuid(), *seeded.far_mechanic.as_uuid(), *seeded.manager.as_uuid()];
        sqlx::query("SELECT console_revise_person_facts(org_id,person_id,'{\"phone\":\"+82212345678\"}'::jsonb,NULL) FROM users WHERE id=ANY($1)")
            .bind(&ids).execute(&pool).await.unwrap();
        sqlx::query("UPDATE users SET phone=CASE WHEN id=$1 THEN '+821012345678' ELSE NULL END WHERE id=ANY($2)")
            .bind(seeded.near_mechanic.as_uuid()).bind(&ids).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM registered_devices WHERE user_id=$1")
            .bind(seeded.manager.as_uuid()).execute(&pool).await.unwrap();
        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);
        let timer = DispatchTimerConfig::default();
        let started = store.start_dispatch(StartP1DispatchCommand {
            actor: seeded.receptionist, work_order_id: seeded.work_order_id,
            incident_location: None, include_region: false, trace: TraceContext::generate(), occurred_at: now,
        }, timer).await.unwrap();
        let due = now + timer.alimtalk_no_ack_after;
        store.mark_alimtalk_no_ack(ExpireP1DispatchCommand {
            dispatch_id: started.id, trace: TraceContext::generate(), occurred_at: due,
        }).await.unwrap();
        for (user, expected) in [(seeded.near_mechanic, "PENDING"), (seeded.far_mechanic, "SKIPPED")] {
            let status: String = sqlx::query_scalar("SELECT status FROM p1_dispatch_alerts WHERE dispatch_id=$1 AND recipient_user_id=$2 AND alert_type='ALIMTALK_NO_ACK'")
                .bind(started.id.as_uuid()).bind(user.as_uuid()).fetch_one(&pool).await.unwrap();
            assert_eq!(status, expected);
        }
        let alerts = store.claim_alimtalk_no_ack_alerts(started.id, due).await.unwrap();
        assert_eq!(alerts.iter().find(|a| a.user_id==seeded.near_mechanic).unwrap().phone, "+821012345678");
        store.expire_accept_window(ExpireP1DispatchCommand {
            dispatch_id: started.id, trace: TraceContext::generate(), occurred_at: started.accept_window_ends_at,
        }).await.unwrap();
        let manager: String = sqlx::query_scalar("SELECT status FROM p1_dispatch_alerts WHERE dispatch_id=$1 AND recipient_user_id=$2 AND alert_type='MANAGER_FORCE_ASSIGN'")
            .bind(started.id.as_uuid()).bind(seeded.manager.as_uuid()).fetch_one(&pool).await.unwrap();
        assert_eq!(manager, "SKIPPED", "the human phone does not make an account contactable");
    }).await;
}
