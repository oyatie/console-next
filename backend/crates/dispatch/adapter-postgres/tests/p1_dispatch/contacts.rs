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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_claims_respect_the_first_delivery_lease(pool: PgPool) {
    console_platform_request_context::scope_org(OrgId::one(), async move {
        let seeded = seed_dispatch_context(&pool).await;
        let store = PgDispatchStore::new(pool.clone());
        let now = datetime!(2026-06-12 09:00 UTC);
        let timers = DispatchTimerConfig::default();
        let started = store
            .start_dispatch(
                StartP1DispatchCommand {
                    actor: seeded.receptionist,
                    work_order_id: seeded.work_order_id,
                    incident_location: None,
                    include_region: false,
                    trace: TraceContext::generate(),
                    occurred_at: now,
                },
                timers,
            )
            .await
            .unwrap();
        let due = now + timers.alimtalk_no_ack_after;
        store
            .mark_alimtalk_no_ack(ExpireP1DispatchCommand {
                dispatch_id: started.id,
                trace: TraceContext::generate(),
                occurred_at: due,
            })
            .await
            .unwrap();

        // Keep the winning transaction uncommitted until both claim statements see PENDING.
        let mut winner = pool.begin().await.unwrap();
        let won: Vec<String> = sqlx::query_scalar(
            "UPDATE p1_dispatch_alerts SET status='SENDING', lease_token=gen_random_uuid(),
                    lease_expires_at=$2 WHERE dispatch_id=$1 AND status='PENDING' RETURNING alert_type",
        )
        .bind(started.id.as_uuid())
        .bind(due + console_dispatch_adapter_postgres::ALERT_LEASE_TTL)
        .fetch_all(winner.as_mut())
        .await
        .unwrap();
        for kind in ["FCM_PUSH", "ALIMTALK_NO_ACK"] {
            assert!(won.iter().any(|alert| alert == kind));
        }

        let (push, alimtalk, ()) = tokio::join!(
            store.claim_fcm_pushes(started.id, "FCM_PUSH", due),
            store.claim_alimtalk_no_ack_alerts(started.id, due),
            async {
                tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    loop {
                        let waiting: i64 = sqlx::query_scalar(
                            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
                             AND wait_event_type='Lock' AND query LIKE '%WITH claimable AS%'",
                        ).fetch_one(&pool).await.unwrap();
                        if waiting == 2 {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("both claim statements should reach the locked alerts");
                winner.commit().await.unwrap();
            }
        );
        assert!(push.unwrap().is_empty());
        assert!(alimtalk.unwrap().is_empty());
    })
    .await;
}
