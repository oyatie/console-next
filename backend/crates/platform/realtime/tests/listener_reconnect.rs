#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! TS-15 for the live hub: the one LISTEN connection behind every subscriber
//! is terminated (a failover or `pg_terminate_backend`). The hub must keep its
//! subscribers open and resume delivery once the listener reconnects; a wake
//! sent while it was down may be lost (clients resync by cursor), but nothing
//! after the reconnect is.

use std::sync::Arc;
use std::time::Duration;

use console_kernel_core::{BranchScope, NotificationId, OrgId, UserId};
use console_platform_realtime::{
    NOTIFICATION_CREATED_CHANNEL, NotificationNotifyPayload, PgRealtimeHub, RealtimeEvent,
    RealtimeHubConfig, RealtimePrincipal,
};
use sqlx::PgPool;
use tokio::time::timeout;

async fn wake(owner: &PgPool, recipient: UserId) -> NotificationId {
    let id = NotificationId::new();
    let link = console_notifications_domain::NotificationLink::Screen {
        screen: "notifications".into(),
    };
    sqlx::query("INSERT INTO notifications(id,org_id,recipient_user_id,category,body,link) VALUES($1,$2,$3,'test','재연결 확인',$4)")
        .bind(*id.as_uuid())
        .bind(*OrgId::one().as_uuid())
        .bind(*recipient.as_uuid())
        .bind(serde_json::to_value(link).unwrap())
        .execute(owner)
        .await
        .unwrap();
    let payload = NotificationNotifyPayload {
        notification_id: id,
        recipient_user_id: recipient,
        org_id: OrgId::one(),
    };
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(NOTIFICATION_CREATED_CHANNEL)
        .bind(serde_json::to_value(payload).unwrap().to_string())
        .execute(owner)
        .await
        .unwrap();
    id
}

async fn kill_listener(owner: &PgPool) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FILTER (WHERE pg_terminate_backend(pid)) FROM pg_stat_activity \
         WHERE datname = current_database() AND pid <> pg_backend_pid() AND query ILIKE 'LISTEN %'",
    )
    .fetch_one(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_killed_listener_reconnects_and_keeps_delivering_to_open_subscribers(owner: PgPool) {
    console_platform_request_context::scope_org(OrgId::one(), async move {
        let recipient = UserId::new();
        sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, '재연결', ARRAY['ADMIN'], $2)")
            .bind(*recipient.as_uuid())
            .bind(*OrgId::one().as_uuid())
            .execute(&owner)
            .await
            .unwrap();
        let runtime = sqlx::postgres::PgPoolOptions::new()
            .after_connect(|conn, _| {
                Box::pin(async move {
                    sqlx::query("SET ROLE console_rt").execute(conn).await?;
                    Ok(())
                })
            })
            .connect_with(owner.connect_options().as_ref().clone())
            .await
            .unwrap();
        let hub = Arc::new(PgRealtimeHub::new(runtime, RealtimeHubConfig::default()));
        let _listener = hub.clone().start_postgres_listener().await.unwrap();
        let principal = RealtimePrincipal {
            user_id: recipient,
            branch_scope: BranchScope::All,
            org_id: OrgId::one(),
        };
        let mut subscriber = hub.connect(principal, None).await.unwrap();
        let delivered = |event: RealtimeEvent| match event {
            RealtimeEvent::NotificationCreated { notification } => notification.id,
            other => panic!("expected a notification, got {other:?}"),
        };

        let first = wake(&owner, recipient).await;
        let got = timeout(Duration::from_secs(5), subscriber.recv()).await.unwrap().unwrap();
        assert_eq!(delivered(got), first);

        assert!(kill_listener(&owner).await >= 1, "the LISTEN connection was found and killed");
        // Wakes during the gap may be lost; keep waking until one lands.
        let mut sent = Vec::new();
        let mut landed = None;
        for _ in 0..40 {
            sent.push(wake(&owner, recipient).await);
            if let Ok(event) = timeout(Duration::from_millis(250), subscriber.recv()).await {
                landed = Some(delivered(event.expect("the subscriber stays open")));
                break;
            }
        }
        let landed = landed.expect("delivery never resumed after the listener died");
        assert!(sent.contains(&landed), "only wakes sent after the kill can arrive now");
        assert_eq!(hub.connection_count().await, 1, "the subscriber was not dropped");

        // After the reconnect every wake is delivered, in order.
        let after = [wake(&owner, recipient).await, wake(&owner, recipient).await];
        let mut seen = Vec::new();
        while seen.len() < 2 {
            let event = timeout(Duration::from_secs(5), subscriber.recv()).await.unwrap().unwrap();
            let id = delivered(event);
            if after.contains(&id) {
                seen.push(id);
            }
        }
        assert_eq!(seen, after);
        hub.shutdown().await;
    })
    .await;
}
