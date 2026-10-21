//! RT-5 replay against Postgres: `Last-Event-ID` resumes with the overlap
//! superset, coalesced, then `hello`; an unknown cursor gets `reset{pruned}`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::*;
use console_kernel_core::{BranchScope, OrgId};
use console_platform_realtime::{
    PgRealtimeHub, RealtimeEvent, RealtimeHubConfig, ResetReason, StreamFrom,
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
