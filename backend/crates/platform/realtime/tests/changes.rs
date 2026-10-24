//! RT-0/RT-4 against Postgres: the audit trigger writes `resource_changes`
//! and wakes the hub once per transaction; the hub re-reads under RLS,
//! filters per reader and resets on a listener gap.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use console_kernel_core::{AuditEvent, BranchScope, OrgId};
use console_platform_realtime::{
    PgRealtimeHub, RESOURCE_CHANGED_CHANNEL, RealtimeConnection, RealtimeEvent, RealtimeHubConfig,
    ResetReason, StreamFrom,
};
use console_platform_test_support::{runtime_role_pool, seed_branch, seed_org_and_super_admin};
use sqlx::PgPool;
use sqlx::postgres::PgListener;
use tokio::time::timeout;

async fn commit_as_leave_definer(pool: &PgPool, org: OrgId, events: &[AuditEvent]) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SET LOCAL ROLE console_leave_definer")
        .execute(&mut *tx)
        .await
        .unwrap();
    for event in events {
        console_platform_db::insert_audit_event(&mut tx, event)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
}

async fn changes(pool: &PgPool, org: OrgId) -> Vec<(String, Option<String>, Option<uuid::Uuid>)> {
    sqlx::query_as(
        "SELECT resource_type, resource_id, branch_id FROM resource_changes \
         WHERE org_id = $1 ORDER BY seq",
    )
    .bind(*org.as_uuid())
    // rls-arming: ok the sqlx::test owner pool reads as BYPASSRLS to observe the trigger
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn quiet(connection: &mut RealtimeConnection) {
    assert!(
        timeout(Duration::from_millis(400), connection.recv())
            .await
            .is_err(),
        "no frame expected"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_mapped_audit_emits_its_change_in_the_same_transaction(pool: PgPool) {
    let org = OrgId::one();
    let map: Vec<(String, String, String, bool)> = sqlx::query_as(
        "SELECT target_type, action, resource_type, carries_id FROM realtime_topic_map",
    )
    // rls-arming: ok global vocabulary table, no RLS
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        map.len() >= 80,
        "the MVP aggregates are mapped: {}",
        map.len()
    );
    let mut wakes = PgListener::connect_with(&pool).await.unwrap();
    wakes.listen(RESOURCE_CHANGED_CHANNEL).await.unwrap();

    for (target_type, action, resource_type, carries_id) in map {
        let id = uuid::Uuid::new_v4().to_string();
        // Two rows in one transaction: still exactly one wake.
        let events = vec![
            event(org, (&target_type, &id), &action, None),
            event(org, (&target_type, &id), &action, None),
        ];
        if matches!(
            action.as_str(),
            "data_import.apply" | "leave_request.decide"
        ) {
            // These protected audits are emitted by the leave/import command writer.
            commit_as_leave_definer(&pool, org, &events).await;
        } else {
            commit(&pool, org, events).await;
        }
        let wake = timeout(Duration::from_secs(5), wakes.recv())
            .await
            .unwrap()
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(wake.payload()).unwrap();
        assert_eq!(payload["org"], org.as_uuid().to_string(), "{action}");
        assert!(
            payload["tx"].as_str().unwrap().parse::<u64>().is_ok(),
            "{action}"
        );
        let rows: Vec<_> = changes(&pool, org)
            .await
            .into_iter()
            .filter(|(kind, row_id, _)| {
                kind == &resource_type && row_id.as_deref() == carries_id.then_some(id.as_str())
            })
            .collect();
        assert!(
            !rows.is_empty(),
            "{target_type} {action} -> {resource_type}"
        );
    }
    assert!(
        timeout(Duration::from_millis(300), wakes.recv())
            .await
            .is_err(),
        "one wake per transaction"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reads_previews_rollbacks_and_the_migrator_emit_nothing(pool: PgPool) {
    let org = OrgId::one();
    let id = uuid::Uuid::new_v4().to_string();
    for (target, action) in [
        ("person", "person.view"),
        ("entity_document", "entity_document.read"),
        ("data_import_run", "data_import.preview"),
        ("data_import_run", "data_import.dry_run"),
        ("org_change_request", "org_change.effectuate.refused"),
        ("policy_role", "policy.role.update.snapshot"),
    ] {
        commit(&pool, org, vec![event(org, (target, &id), action, None)]).await;
    }
    // A rollback: the deferred trigger never runs.
    let mut tx = pool.begin().await.unwrap();
    console_platform_db::insert_audit_event(
        &mut tx,
        &event(org, ("employee", "x"), "employee.create", None),
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    // A migration session (SESSION_USER = console_app) emits nothing (F16).
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL SESSION AUTHORIZATION console_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    console_platform_db::insert_audit_event(
        &mut tx,
        &event(org, ("employee", "y"), "employee.create", None),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(changes(&pool, org).await, vec![]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_hub_filters_each_reader_and_resets_on_a_listener_gap(pool: PgPool) {
    let org = OrgId::one();
    let other_org = OrgId::from_uuid(uuid::Uuid::new_v4());
    seed_org_and_super_admin(&pool, *other_org.as_uuid(), "rt-other").await;
    let (x, y) = (
        seed_branch(&pool, "rt", "x").await,
        seed_branch(&pool, "rt", "y").await,
    );
    // The hub reads as console_rt, so its re-read only works if it arms RLS.
    let hub = Arc::new(PgRealtimeHub::new(
        runtime_role_pool(&pool).await,
        RealtimeHubConfig::default(),
    ));
    let _bridge = Arc::clone(&hub).start_postgres_listener().await.unwrap();
    let mut tenant_wide = hub
        .connect_stream(reader(org, HR, BranchScope::All), StreamFrom::default())
        .await;
    let mut branch_y = hub
        .connect_stream(
            reader(org, HR, BranchScope::single(y)),
            StreamFrom::default(),
        )
        .await;
    let mut no_grant = hub
        .connect_stream(reader(org, &[], BranchScope::All), StreamFrom::default())
        .await;
    let mut other_tenant = hub
        .connect_stream(
            reader(other_org, HR, BranchScope::All),
            StreamFrom::default(),
        )
        .await;
    assert_eq!(hello(&mut tenant_wide).await, 0);
    for connection in [&mut branch_y, &mut no_grant, &mut other_tenant] {
        hello(connection).await;
    }

    let in_x = uuid::Uuid::new_v4().to_string();
    let in_y = uuid::Uuid::new_v4().to_string();
    commit(
        &pool,
        org,
        vec![
            event(org, ("employee", &in_x), "employee.create", Some(x)),
            event(org, ("employee", &in_y), "employee.create", Some(y)),
        ],
    )
    .await;

    let first = change(&next(&mut tenant_wide).await);
    let second = change(&next(&mut tenant_wide).await);
    assert_eq!(
        [(first.1.clone(), first.2.clone()), (second.1, second.2)],
        [
            ("employee".to_owned(), Some(in_x)),
            ("employee".to_owned(), Some(in_y.clone()))
        ]
    );
    let (_, kind, id) = change(&next(&mut branch_y).await);
    assert_eq!((kind.as_str(), id), ("employee", Some(in_y)));
    quiet(&mut branch_y).await;
    quiet(&mut no_grant).await;
    quiet(&mut other_tenant).await;

    // A forged wake for this tenant names no rows: nothing is sent.
    sqlx::query("SELECT pg_notify($1, $2)")
        .bind(RESOURCE_CHANGED_CHANNEL)
        .bind(format!(r#"{{"org":"{}","tx":"1"}}"#, org.as_uuid()))
        // rls-arming: ok pg_notify is not a tenant-table read
        .execute(&pool)
        .await
        .unwrap();
    quiet(&mut tenant_wide).await;

    // Listener killed → it reconnects and every stream gets reset{gap}.
    sqlx::query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
         WHERE datname = current_database() AND pid <> pg_backend_pid()",
    )
    // rls-arming: ok catalog read, no tenant table
    .execute(&pool)
    .await
    .unwrap();
    match next(&mut tenant_wide).await {
        RealtimeEvent::Reset { data } => assert_eq!(data.reason, ResetReason::Gap),
        other => panic!("expected reset, got {other:?}"),
    }
}
