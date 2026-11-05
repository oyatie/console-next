//! RT-5 replay against Postgres: `Last-Event-ID` resumes with the overlap
//! superset, coalesced, then `hello`; an unknown cursor gets `reset{pruned}`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use console_kernel_core::{BranchScope, OrgId};
use console_platform_realtime::{
    DisconnectReason, PgRealtimeHub, RealtimeEvent, RealtimeHubConfig, ResetReason, StreamFrom,
};
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_cursor_replays_the_overlap_superset_then_hello(pool: PgPool) {
    let org = OrgId::one();
    let hub = Arc::new(PgRealtimeHub::new(
        runtime_role_pool(&pool).await,
        RealtimeHubConfig {
            coalesce_threshold: 2,
            ..Default::default()
        },
    ));
    let ids: Vec<String> = (0..3).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    for id in &ids {
        commit(
            &pool,
            org,
            vec![event(
                org,
                ("legal_entity", id),
                "legal_entity.create",
                None,
            )],
        )
        .await;
    }
    let head: i64 = sqlx::query_scalar("SELECT MAX(seq) FROM resource_changes")
        // rls-arming: ok the sqlx::test owner pool reads as BYPASSRLS to observe the trigger
        .fetch_one(&pool)
        .await
        .unwrap();
    let all = reader(org, HR, BranchScope::All);

    // Resume from the last row: the 45 s overlap re-sends the earlier rows
    // too (commit order is not seq order), coalesced past the threshold.
    let mut resumed = hub
        .connect_stream(
            all.clone(),
            StreamFrom {
                last_message_id: None,
                last_event_id: Some(head),
            },
        )
        .await;
    let (seq, kind, id) = change(&next(&mut resumed).await);
    assert_eq!((seq, kind.as_str(), id), (head, "legal_entity", None));
    assert_eq!(hello(&mut resumed).await, head);

    // An unknown (or pruned) cursor: reset{pruned}, then hello.
    let mut stale = hub
        .connect_stream(
            all,
            StreamFrom {
                last_message_id: None,
                last_event_id: Some(head + 1_000),
            },
        )
        .await;
    match next(&mut stale).await {
        RealtimeEvent::Reset { data } => assert_eq!(data.reason, ResetReason::Pruned),
        other => panic!("expected reset, got {other:?}"),
    }
    assert_eq!(hello(&mut stale).await, head);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn replay_counts_rows_even_when_the_reader_cannot_see_them(pool: PgPool) {
    let org = OrgId::one();
    for _ in 0..3 {
        commit(
            &pool,
            org,
            vec![event(
                org,
                ("legal_entity", &uuid::Uuid::new_v4().to_string()),
                "legal_entity.create",
                None,
            )],
        )
        .await;
    }
    let hub = Arc::new(PgRealtimeHub::new(
        runtime_role_pool(&pool).await,
        RealtimeHubConfig {
            max_replay_rows: 2,
            ..Default::default()
        },
    ));
    let mut connection = hub
        .connect_stream(
            reader(org, &[], BranchScope::All),
            StreamFrom {
                last_event_id: Some(0),
                ..Default::default()
            },
        )
        .await;
    reset(&mut connection).await;
    let head = hello(&mut connection).await;
    assert!(head > 0);
    assert_eq!(hub.limit_hits(), [0, 0, 1]);
    assert_live(&pool, &hub, &mut connection).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn replay_deadline_cancels_waiting_database_work(pool: PgPool) {
    let hub = Arc::new(PgRealtimeHub::new(
        runtime_role_pool(&pool).await,
        RealtimeHubConfig {
            replay_timeout: std::time::Duration::from_millis(50),
            ..Default::default()
        },
    ));
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE resource_changes IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let mut connection = hub
        .connect_stream(
            reader(OrgId::one(), HR, BranchScope::All),
            StreamFrom::default(),
        )
        .await;
    let notice = tokio::time::timeout(std::time::Duration::from_secs(7), connection.disconnect())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notice.reason, DisconnectReason::ReplayFailed);
    assert_eq!(hub.limit_hits(), [0, 0, 1]);
    assert_eq!(hub.connection_count().await, 0);
    lock.rollback().await.unwrap();
}

async fn reset(connection: &mut console_platform_realtime::RealtimeConnection) {
    match next(connection).await {
        RealtimeEvent::Reset { data } => assert_eq!(data.reason, ResetReason::Pruned),
        other => panic!("expected reset, got {other:?}"),
    }
}

async fn assert_live(
    pool: &PgPool,
    hub: &Arc<PgRealtimeHub>,
    connection: &mut console_platform_realtime::RealtimeConnection,
) {
    let bridge = Arc::clone(hub).start_postgres_listener().await.unwrap();
    sqlx::query("SELECT pg_notify('privacy_consent_changed', '')")
        .execute(pool)
        .await
        .unwrap();
    assert_eq!(
        next(connection).await,
        RealtimeEvent::PrivacyConsent { accepted: false }
    );
    assert_eq!(hub.connection_count().await, 1);
    bridge.shutdown();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_overlapping_burst_resets_on_reconnect_and_keeps_live_changes(pool: PgPool) {
    let org = OrgId::one();
    let hub = Arc::new(PgRealtimeHub::new(
        runtime_role_pool(&pool).await,
        RealtimeHubConfig {
            max_replay_rows: 2,
            ..Default::default()
        },
    ));
    let bridge = Arc::clone(&hub).start_postgres_listener().await.unwrap();
    let principal = reader(org, HR, BranchScope::All);
    let mut connection = hub
        .connect_stream(principal.clone(), StreamFrom::default())
        .await;
    let mut cursor = hello(&mut connection).await;
    for _ in 0..3 {
        commit(
            &pool,
            org,
            vec![event(
                org,
                ("legal_entity", &uuid::Uuid::new_v4().to_string()),
                "legal_entity.create",
                None,
            )],
        )
        .await;
        change(&next(&mut connection).await);
    }
    hub.remove_connection(connection.id()).await;
    let head: i64 = sqlx::query_scalar("SELECT MAX(seq) FROM resource_changes")
        // rls-arming: ok the sqlx::test owner observes the audit trigger
        .fetch_one(&pool)
        .await
        .unwrap();
    for _ in 0..2 {
        connection = hub
            .connect_stream(
                principal.clone(),
                StreamFrom {
                    last_event_id: Some(cursor),
                    ..Default::default()
                },
            )
            .await;
        reset(&mut connection).await;
        cursor = hello(&mut connection).await;
        assert_eq!(cursor, head);
        hub.remove_connection(connection.id()).await;
    }
    connection = hub
        .connect_stream(
            principal,
            StreamFrom {
                last_event_id: Some(cursor),
                ..Default::default()
            },
        )
        .await;
    reset(&mut connection).await;
    assert_eq!(hello(&mut connection).await, head);
    let id = uuid::Uuid::new_v4().to_string();
    commit(
        &pool,
        org,
        vec![event(
            org,
            ("legal_entity", &id),
            "legal_entity.create",
            None,
        )],
    )
    .await;
    let (seq, kind, live_id) = change(&next(&mut connection).await);
    assert!(seq > head);
    assert_eq!(kind, "legal_entity");
    assert_eq!(live_id.as_deref(), Some(id.as_str()));
    assert_eq!(hub.limit_hits(), [0, 0, 3]);
    assert_eq!(hub.connection_count().await, 1);
    bridge.shutdown();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_replay_deadline_resets_then_reads_head_and_resumes_live(pool: PgPool) {
    let hub = Arc::new(PgRealtimeHub::new(
        runtime_role_pool(&pool).await,
        RealtimeHubConfig {
            replay_timeout: Duration::from_millis(50),
            ..Default::default()
        },
    ));
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE resource_changes IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let mut connection = hub
        .connect_stream(
            reader(OrgId::one(), HR, BranchScope::All),
            StreamFrom {
                last_event_id: Some(0),
                ..Default::default()
            },
        )
        .await;
    reset(&mut connection).await;
    lock.rollback().await.unwrap();
    assert_eq!(hello(&mut connection).await, 0);
    assert_eq!(hub.limit_hits(), [0, 0, 1]);
    assert_live(&pool, &hub, &mut connection).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn messenger_replay_refuses_backlog_over_the_row_budget(pool: PgPool) {
    use console_kernel_core::MessageId;
    let org = OrgId::one();
    let branch = console_platform_test_support::seed_branch(&pool, "replay", "replay").await;
    let user = console_platform_test_support::seed_user(&pool, "Reader", "ADMIN", branch).await;
    let thread = uuid::Uuid::new_v4();
    let cursor = MessageId::new();
    sqlx::query("INSERT INTO messenger_threads(id,org_id,kind,branch_id,created_by,visibility) VALUES($1,$2,'team',$3,$4,'direct')")
        .bind(thread).bind(org.as_uuid()).bind(branch.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messenger_thread_members(thread_id,user_id,org_id,joined_at) VALUES($1,$2,$3,now())")
        .bind(thread).bind(user.as_uuid()).bind(org.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messenger_messages(id,org_id,thread_id,branch_id,sender_id,body,sent_at) VALUES($1,$2,$3,$4,$5,'cursor',now()-interval '1 day')")
        .bind(cursor.as_uuid()).bind(org.as_uuid()).bind(thread).bind(branch.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messenger_messages(id,org_id,thread_id,branch_id,sender_id,body,sent_at) SELECT gen_random_uuid(),$1,$2,$3,$4,'unread',now() FROM generate_series(1,2)")
        .bind(org.as_uuid()).bind(thread).bind(branch.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    let hub = Arc::new(PgRealtimeHub::new(
        runtime_role_pool(&pool).await,
        RealtimeHubConfig {
            max_replay_rows: 1,
            ..Default::default()
        },
    ));
    let mut connection = hub
        .connect(
            console_platform_realtime::RealtimePrincipal {
                org_id: org,
                user_id: user,
                branch_scope: BranchScope::All,
            },
            Some(cursor),
        )
        .await
        .unwrap();
    let notice = tokio::time::timeout(std::time::Duration::from_secs(5), connection.disconnect())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(notice.reason, DisconnectReason::ReplayFailed);
    assert_eq!(hub.limit_hits(), [0, 0, 1]);
    assert_eq!(hub.connection_count().await, 0);
}
