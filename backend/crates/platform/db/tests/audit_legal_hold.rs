#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! SEC-K1-c: Legal hold on 접속기록/audit_events:
//! While a hold is active for a tenant, no path deletes its audit rows (tenant force-remove included).
//! With an active hold, force-removing the tenant (the 0059/0081 path) is refused with a typed error
//! and every audit_events row remains; after release the existing force-remove test still passes;
//! a direct DELETE stays refused by audit_events_immutable (regression).
//! Hold place/release is itself audited.

use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn seed_test_org(pool: &PgPool, org_id: Uuid, name: &str) {
    let slug = format!("org-{}", &org_id.simple().to_string()[..16]);
    sqlx::query(
        "INSERT INTO organizations (id, slug, name, status) VALUES ($1, $2, $3, 'ARCHIVED')",
    )
    .bind(org_id)
    .bind(slug)
    .bind(name)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO audit_events (org_id, action, target_type, target_id, before_snap, after_snap,
                                   trace_id, span_id, occurred_at)
         VALUES ($1, 'organization.created', 'organizations', $2, NULL, '{\"status\":\"ARCHIVED\"}',
                 repeat('a', 32), repeat('b', 16), now())",
    )
    .bind(org_id)
    .bind(org_id.to_string())
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn test_force_remove_refused_while_legal_hold_active_and_audit_events_survive(pool: PgPool) {
    let org_id = Uuid::new_v4();
    seed_test_org(&pool, org_id, "Tenant Under Hold").await;

    // Place an active legal hold on the organization's audit events
    let hold_id: Uuid = sqlx::query_scalar(
        "SELECT audit_legal_hold_place($1, 'regulatory compliance audit hold', NULL)",
    )
    .bind(org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(hold_id, Uuid::nil());

    // Verify initial audit_events count for the tenant
    let initial_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1")
            .bind(org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(initial_count >= 1, "tenant must have audit rows");

    // Force-removing the tenant (the 0059/0081/0228 path) must be refused with a typed error
    let remove_err = sqlx::query("SELECT platform_force_remove_organization($1)")
        .bind(org_id)
        .execute(&pool)
        .await
        .unwrap_err();

    let db_err = remove_err
        .as_database_error()
        .expect("must be a database error");
    assert!(
        db_err.code().as_deref() == Some("55000") || db_err.code().as_deref() == Some("23514"),
        "must be refused with a typed error code (55000 or 23514), got: {:?}",
        db_err.code()
    );

    // Organization must not have been removed
    let org_count: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations WHERE id = $1")
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(org_count, 1, "organization row must remain");

    // Every audit_events row must remain untouched
    let after_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id = $1")
            .bind(org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        after_count, initial_count,
        "all audit_events rows must remain for the tenant"
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn test_force_remove_succeeds_after_legal_hold_released(pool: PgPool) {
    let org_id = Uuid::new_v4();
    seed_test_org(&pool, org_id, "Tenant Hold Released").await;

    // Place an active legal hold
    let hold_id: Uuid =
        sqlx::query_scalar("SELECT audit_legal_hold_place($1, 'temporary preservation', NULL)")
            .bind(org_id)
            .fetch_one(&pool)
            .await
            .unwrap();

    // Release the legal hold
    sqlx::query("SELECT audit_legal_hold_release($1, 'audit completed and closed', NULL)")
        .bind(hold_id)
        .execute(&pool)
        .await
        .unwrap();

    // After release, force-removing the tenant must succeed
    let outcome: String = sqlx::query_scalar("SELECT platform_force_remove_organization($1)")
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .expect("force removal must succeed after legal hold is released");
    assert_eq!(outcome, "removed");

    // The tenant organization must be deleted
    let org_count: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations WHERE id = $1")
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(org_count, 0, "tenant must be removed");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn test_direct_delete_stays_refused_by_audit_events_immutable(pool: PgPool) {
    let org_id = Uuid::new_v4();
    seed_test_org(&pool, org_id, "Tenant Immutable Check").await;

    let delete_err = sqlx::query("DELETE FROM audit_events WHERE org_id = $1")
        .bind(org_id)
        .execute(&pool)
        .await
        .unwrap_err();

    let err_msg = delete_err.to_string();
    assert!(
        err_msg.contains("audit_events is append-only") && err_msg.contains("DELETE is forbidden"),
        "direct DELETE must stay refused by audit_events_immutable: {err_msg}"
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn test_legal_hold_place_and_release_are_audited(pool: PgPool) {
    let org_id = Uuid::new_v4();
    seed_test_org(&pool, org_id, "Audited Hold Actions").await;

    // Place hold
    let hold_id: Uuid = sqlx::query_scalar(
        "SELECT audit_legal_hold_place($1, 'formal investigation request', NULL)",
    )
    .bind(org_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    // Verify placement audit event was recorded
    let place_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'audit.legal_hold.placed'",
    )
    .bind(org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(place_events, 1, "hold placement must be audited");

    // Release hold
    sqlx::query("SELECT audit_legal_hold_release($1, 'investigation concluded', NULL)")
        .bind(hold_id)
        .execute(&pool)
        .await
        .unwrap();

    // Verify release audit event was recorded
    let release_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'audit.legal_hold.released'",
    )
    .bind(org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(release_events, 1, "hold release must be audited");
}
