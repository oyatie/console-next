// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Legal-hold authority, immutable evidence and request-correlated audit preservation.

use sqlx::{PgPool, Row};
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
const PLACE: &str = "SELECT audit_legal_hold_place($1, 'CASE-42', 'preservation order',
    'investigation', $2, repeat('a', 32)::char(32), repeat('b', 16)::char(16),
    '2026-10-22T09:00:00Z'::timestamptz)";
const RELEASE: &str = "SELECT audit_legal_hold_release($1, 'case closed', $2,
    repeat('c', 32)::char(32), repeat('d', 16)::char(16),
    '2026-10-22T10:00:00Z'::timestamptz)";

async fn org(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name, status) VALUES ($1, $2, 'Hold test', 'ARCHIVED')")
        .bind(id).bind(format!("hold-{}", &id.simple().to_string()[..16])).execute(pool).await.unwrap();
    id
}

async fn fixture(pool: &PgPool) -> (Uuid, Uuid) {
    let target = org(pool).await;
    let platform_org = org(pool).await;
    let actor = sqlx::query_scalar("INSERT INTO users (display_name, roles, org_id) VALUES ('Hold operator', ARRAY['SUPER_ADMIN'], $1) RETURNING id")
        .bind(platform_org).fetch_one(pool).await.unwrap();
    (target, actor)
}

async fn place(pool: &PgPool, org: Uuid, actor: Uuid) -> Uuid {
    sqlx::query_scalar(PLACE)
        .bind(org)
        .bind(actor)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn release(pool: &PgPool, hold: Uuid, actor: Uuid) {
    sqlx::query(RELEASE)
        .bind(hold)
        .bind(actor)
        .execute(pool)
        .await
        .unwrap();
}

fn refused(error: &sqlx::Error, code: &str) {
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some(code),
        "{error}"
    );
}

#[path = "audit_legal_hold/authority.rs"]
mod authority;
#[path = "audit_legal_hold/registry.rs"]
mod registry;

#[sqlx::test(migrator = "MIGRATOR")]
async fn platform_command_preserves_correlated_events_after_release_and_removal(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL ROLE console_platform_force_cmd")
        .execute(&mut *tx)
        .await
        .unwrap();
    let hold: Uuid = sqlx::query_scalar(PLACE)
        .bind(target)
        .bind(actor)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query(RELEASE)
        .bind(hold)
        .bind(actor)
        .execute(&mut *tx)
        .await
        .unwrap();
    let outcome: String = sqlx::query_scalar("SELECT platform_force_remove_organization_command($1, $2, repeat('e',32)::char(32), repeat('f',16)::char(16), now())")
        .bind(target).bind(actor).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(outcome, "removed");
    tx.commit().await.unwrap();
    let events = sqlx::query("SELECT action, actor, trace_id, span_id, occurred_at::text AS occurred_at, after_snap FROM audit_events WHERE org_id = '00000000-0000-0000-0000-00000000face' AND target_id = $1 ORDER BY action")
        .bind(target.to_string()).fetch_all(&pool).await.unwrap();
    assert_eq!(events.len(), 2);
    for (event, action, trace, span, hour) in [
        (&events[0], "audit.legal_hold.placed", "a", "b", "09"),
        (&events[1], "audit.legal_hold.released", "c", "d", "10"),
    ] {
        assert_eq!(event.get::<String, _>("action"), action);
        assert_eq!(event.get::<String, _>("trace_id"), trace.repeat(32));
        assert_eq!(event.get::<String, _>("span_id"), span.repeat(16));
        assert_eq!(
            event.get::<String, _>("occurred_at"),
            format!("2026-10-22 {hour}:00:00+00")
        );
        assert_eq!(event.get::<Option<Uuid>, _>("actor"), None);
        assert_eq!(
            event.get::<serde_json::Value, _>("after_snap")["hold_id"],
            hold.to_string()
        );
    }
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn active_hold_blocks_both_removal_paths_and_preserves_attribution(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    place(&pool, target, actor).await;
    for command in ["SELECT platform_force_remove_organization($1)"] {
        let error = sqlx::query(command)
            .bind(target)
            .execute(&pool)
            .await
            .unwrap_err();
        refused(&error, "55000");
        assert_eq!(
            error.as_database_error().unwrap().constraint(),
            Some("audit_legal_holds_active")
        );
    }
    let outcome: String = sqlx::query_scalar("SELECT platform_remove_organization($1)")
        .bind(target)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(outcome, "blocked_legal_hold");
    let attribution: Option<Uuid> = sqlx::query_scalar(
        "SELECT actor FROM audit_events WHERE org_id = $1 AND action = 'audit.legal_hold.placed'",
    )
    .bind(target)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(attribution, Some(actor));
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1)")
            .bind(target)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(exists);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn active_hold_blocks_force_removal_even_without_audit_rows(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    // Model a hold with no historical audit rows; placement commands always add an event.
    sqlx::query("INSERT INTO docs_evidence_legal_holds (org_id, case_ref, basis, reason, applied_by, applied_at) VALUES ($1, 'CASE-42', 'order', 'preserve', $2, now())")
        .bind(target).bind(actor).execute(&pool).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1")
        .bind(target)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let error = sqlx::query("SELECT platform_force_remove_organization($1)")
        .bind(target)
        .execute(&pool)
        .await
        .unwrap_err();
    refused(&error, "55000");
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some("audit_legal_holds_active")
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn placement_requires_an_existing_organization(pool: PgPool) {
    let (_, actor) = fixture(&pool).await;
    refused(
        &sqlx::query(PLACE)
            .bind(Uuid::new_v4())
            .bind(actor)
            .execute(&pool)
            .await
            .unwrap_err(),
        "P0002",
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn audit_insert_failure_rolls_back_hold_commands(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    refused(&sqlx::query("SELECT audit_legal_hold_place($1, 'case', 'order', 'preserve', $2, NULL, repeat('b',16)::char(16), now())")
        .bind(target).bind(actor).execute(&pool).await.unwrap_err(), "23502");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM docs_evidence_legal_holds WHERE org_id = $1")
            .bind(target)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let hold = place(&pool, target, actor).await;
    refused(&sqlx::query("SELECT audit_legal_hold_release($1, 'closed', $2, NULL, repeat('b',16)::char(16), now())")
        .bind(hold).bind(actor).execute(&pool).await.unwrap_err(), "23502");
    let status: String =
        sqlx::query_scalar("SELECT status FROM docs_evidence_legal_holds WHERE id = $1")
            .bind(hold)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "ACTIVE");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn direct_audit_delete_stays_refused(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    place(&pool, target, actor).await;
    let error = sqlx::query("DELETE FROM audit_events WHERE org_id = $1")
        .bind(target)
        .execute(&pool)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("audit_events is append-only"));
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn hold_audit_events_keep_caller_context_and_accountable_actors(pool: PgPool) {
    let (target, actor) = fixture(&pool).await;
    let hold = place(&pool, target, actor).await;
    release(&pool, hold, actor).await;
    let events = sqlx::query("SELECT actor, trace_id, span_id, occurred_at = '2026-10-22T09:00:00Z'::timestamptz AS placed_time, occurred_at = '2026-10-22T10:00:00Z'::timestamptz AS released_time, after_snap, principal_type, actor_kind, source, outcome, command_id FROM audit_events WHERE org_id = $1 ORDER BY action")
        .bind(target).fetch_all(&pool).await.unwrap();
    assert_eq!(events.len(), 2);
    for (event, trace, span, time_key) in [
        (&events[0], "a", "b", "placed_time"),
        (&events[1], "c", "d", "released_time"),
    ] {
        assert_eq!(event.get::<Option<Uuid>, _>("actor"), Some(actor));
        assert_eq!(event.get::<String, _>("trace_id"), trace.repeat(32));
        assert_eq!(event.get::<String, _>("span_id"), span.repeat(16));
        assert!(event.get::<bool, _>(time_key));
        assert_eq!(
            event.get::<Option<String>, _>("principal_type").as_deref(),
            Some("SUPPORT_OPERATOR")
        );
        assert_eq!(
            event.get::<Option<String>, _>("actor_kind").as_deref(),
            Some("SUPPORT_OPERATOR")
        );
        assert_eq!(
            event.get::<Option<String>, _>("source").as_deref(),
            Some("API")
        );
        assert_eq!(
            event.get::<Option<String>, _>("outcome").as_deref(),
            Some("ALLOWED")
        );
        assert!(event.get::<Option<Uuid>, _>("command_id").is_some());
    }
    assert_eq!(
        events[0].get::<serde_json::Value, _>("after_snap")["case_ref"],
        "CASE-42"
    );
    assert_eq!(
        events[0].get::<serde_json::Value, _>("after_snap")["basis"],
        "preservation order"
    );
}
