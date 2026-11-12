// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
//! A bulk command keeps every audit row without a database round trip per row.
#[path = "../../../hr/adapter-postgres/tests/support/trail_queries.rs"]
mod queries;
#[path = "command_ledger_support/mod.rs"]
mod support;

use console_platform_db::{DbError, command_context, with_audits};
use serde_json::json;
use sqlx::{PgPool, Row};
use support::Fixture;
use tracing::instrument::WithSubscriber;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn one_and_two_thousand_audits_use_one_insert_and_one_actor_read(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let other = f.another().await;
    let mut totals = Vec::new();
    for (size, inserts) in [(1, 1), (2_000, 1), (2_200, 2)] {
        let command = f.fresh(&format!("audit-batch-command-{size}")).await;
        let events: Vec<_> = (0..size)
            .map(|n| {
                let mut event = f
                    .event(Some(command), "ledger.batch", &n.to_string(), false)
                    .with_snapshots(Some(json!({"before":n})), Some(json!({"after":n})));
                if n % 2 == 1 {
                    event.command_context.as_mut().unwrap().actor_display =
                        Some("Captured actor".into());
                }
                event
            })
            .collect();
        let expected = events.clone();
        let observed = queries::Queries::default();
        command_context::scope(
            f.context(Some(command)),
            with_audits::<_, (), DbError>(&f.rt, f.org, move |_tx| {
                Box::pin(async move { Ok(((), events)) })
            }),
        )
        .with_subscriber(observed.clone())
        .await
        .unwrap();
        let statements = observed.statements();
        eprintln!("audits={size}, statements={}", statements.len());
        totals.push(statements.len());
        for (kind, count) in [
            ("INSERT INTO audit_events", inserts),
            ("FROM person_accounts_current", 1),
        ] {
            assert_eq!(
                statements.iter().filter(|q| q.contains(kind)).count(),
                count,
                "{size} audits must share {kind}"
            );
        }
        let rows = sqlx::query("SELECT * FROM audit_events WHERE org_id=$1 AND command_id=$2 AND action='ledger.batch' ORDER BY target_id::int")
            .bind(f.org.as_uuid()).bind(command).fetch_all(&f.owner).await.unwrap();
        assert_eq!(rows.len(), size);
        for (row, event) in rows.iter().zip(expected) {
            assert_eq!(row.get::<uuid::Uuid, _>("id"), *event.id.as_uuid());
            assert_eq!(row.get::<uuid::Uuid, _>("actor"), *f.actor.as_uuid());
            assert_eq!(
                row.get::<String, _>("actor_display"),
                event
                    .command_context
                    .as_ref()
                    .unwrap()
                    .actor_display
                    .as_deref()
                    .unwrap_or("Ledger actor")
            );
            assert_eq!(row.get::<String, _>("source"), "FORM");
            assert_eq!(row.get::<String, _>("change_mode"), "GOVERNED");
            assert_eq!(row.get::<String, _>("actor_kind"), "OPS_ACCOUNT");
            assert_eq!(row.get::<String, _>("outcome"), "ALLOWED");
            assert_eq!(row.get::<i16, _>("row_hash_version"), 2);
            assert_eq!(
                row.get::<Option<serde_json::Value>, _>("before_snap"),
                event.before
            );
            assert_eq!(
                row.get::<Option<serde_json::Value>, _>("after_snap"),
                event.after
            );
            assert_eq!(
                row.get::<serde_json::Value, _>("decision_snapshot")["approval.policy.org_structure"],
                7
            );
        }
        assert_eq!(f.outcome(command).await.state, "APPLIED");
        let leaked: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND command_id=$2",
        )
        .bind(other.org.as_uuid())
        .bind(command)
        .fetch_one(&f.owner)
        .await
        .unwrap();
        assert_eq!(leaked, 0);
    }
    assert_eq!(
        totals[0], totals[1],
        "audit statement count must not grow with people"
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_foreign_event_rolls_back_the_whole_audit_batch(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let other = f.another().await;
    let events = vec![
        f.event(None, "ledger.batch", "local", false),
        other.event(None, "ledger.batch", "foreign", false),
    ];
    let org = f.org;
    let error = with_audits::<_, (), DbError>(&f.owner, org, move |tx| {
        Box::pin(async move {
            support::write(tx, org, "rolled-back").await?;
            Ok(((), events))
        })
    })
    .await
    .unwrap_err();
    assert!(
        error.to_string().contains("tenant") || error.to_string().contains("row-level security"),
        "{error}"
    );
    assert_eq!(f.domain_count().await, 0);
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=ANY($1) AND action='ledger.batch'",
    )
    .bind(vec![*f.org.as_uuid(), *other.org.as_uuid()])
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(audits, 0);

    let mut event = f.event(None, "ledger.actor", "foreign-actor", false);
    event.actor = Some(other.actor);
    with_audits::<_, (), DbError>(&f.owner, f.org, move |_tx| {
        Box::pin(async move { Ok(((), vec![event])) })
    })
    .await
    .unwrap();
    let display: Option<String> = sqlx::query_scalar(
        "SELECT actor_display FROM audit_events WHERE org_id=$1 AND action='ledger.actor'",
    )
    .bind(f.org.as_uuid())
    .fetch_one(&f.owner)
    .await
    .unwrap();
    assert_eq!(
        display, None,
        "actor lookup must not disclose another tenant's name"
    );

    // Bootstrap still emits global events; their explicit lack of a tenant is retained.
    let mut global = f.event(None, "ledger.global", "global", false);
    global.org_id = None;
    with_audits::<_, (), DbError>(&f.owner, f.org, move |_tx| {
        Box::pin(async move { Ok(((), vec![global])) })
    })
    .await
    .unwrap();
    let org: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT org_id FROM audit_events WHERE action='ledger.global'")
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(org, None);
}
