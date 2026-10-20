#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::OrgId;
use console_platform_auth::RefreshTokenStore;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use time::{Duration, OffsetDateTime};

/// One migrator for every `#[sqlx::test]` in this file (expanded once, not per test).
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../db/migrations");

/// Rotation and logout audit rows go through the shared writer, so they carry
/// `source = SYSTEM`, an actor kind, and a non-NULL decision snapshot.
/// RED on trunk: `insert_audit_in_tx` raw-inserts twelve columns and leaves
/// the command context NULL.
#[sqlx::test(migrator = "MIGRATOR")]
async fn refresh_rotation_and_logout_audit_rows_carry_command_context(pool: PgPool) {
    let user_id = seed_user(&pool).await;
    let store = RefreshTokenStore;
    let now = OffsetDateTime::now_utc();
    let ttl = Duration::days(30);
    let absolute_ttl = Duration::days(30);

    let issued = store
        .issue_family(&pool, user_id, OrgId::one(), now, ttl)
        .await
        .unwrap();
    let rotated = store
        .rotate(
            &pool,
            issued.token.as_str(),
            now + Duration::minutes(1),
            ttl,
            absolute_ttl,
        )
        .await
        .unwrap();
    store
        .revoke_family_for_logout(&pool, rotated.token.as_str(), now + Duration::minutes(2))
        .await
        .unwrap();

    let rt = runtime_role_pool(&pool).await;
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(OrgId::one().as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let rows = sqlx::query(
        "SELECT action, source, actor_kind, decision_snapshot, change_mode, outcome, \
         row_hash_version \
         FROM audit_events \
         WHERE action IN ('auth.refresh', 'auth.logout') \
         ORDER BY action",
    )
    .fetch_all(tx.as_mut())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(
        rows.len(),
        2,
        "rotation and logout each write one audit row"
    );
    for row in &rows {
        let action: String = row.try_get("action").unwrap();
        let source: Option<String> = row.try_get("source").unwrap();
        let actor_kind: Option<String> = row.try_get("actor_kind").unwrap();
        let snapshot: Option<serde_json::Value> = row.try_get("decision_snapshot").unwrap();
        let change_mode: Option<String> = row.try_get("change_mode").unwrap();
        let outcome: Option<String> = row.try_get("outcome").unwrap();
        let row_hash_version: i16 = row.try_get("row_hash_version").unwrap();
        assert_eq!(source.as_deref(), Some("SYSTEM"), "{action} source");
        assert_eq!(
            actor_kind.as_deref(),
            Some("TENANT_USER"),
            "{action} actor_kind"
        );
        assert!(
            snapshot.is_some_and(|value| value.is_object()),
            "{action} context snapshot is null"
        );
        assert!(change_mode.is_some(), "{action} change_mode");
        assert_eq!(outcome.as_deref(), Some("ALLOWED"), "{action} outcome");
        assert_eq!(row_hash_version, 2, "{action} row_hash_version");
    }
}

/// Negative control for the audit-coverage gate: a raw `INSERT INTO audit_events`
/// whose column list omits `source` is refused. The shared writer is not, because
/// it binds `context.source.as_str()`. Trunk fails this: `refresh_audit.rs`
/// still has that raw insert.
#[test]
fn audit_coverage_gate_flags_raw_insert_without_source() {
    let refresh = include_str!("../src/refresh_audit.rs");
    assert!(
        refresh.contains("insert_audit_event"),
        "refresh/logout audit must route through the shared writer"
    );
    assert!(
        refresh.contains("AuditSource::System"),
        "refresh/logout audit must declare source SYSTEM"
    );
    assert!(
        !raw_insert_omits_source(refresh),
        "refresh/logout audit raw-inserts audit_events without source"
    );

    let raw = "INSERT INTO audit_events (id, actor, action) VALUES ($1, $2, $3)";
    assert!(
        raw_insert_omits_source(raw),
        "negative control: a raw insert without source must be flagged"
    );
    let declared = "INSERT INTO audit_events (id, action, source) VALUES ($1, $2, 'SYSTEM')";
    assert!(!raw_insert_omits_source(declared));

    let writer = include_str!("../../db/src/audit_write.rs");
    assert!(
        !raw_insert_omits_source(writer),
        "shared writer names source"
    );
    assert!(!shared_boundary_omits_source(writer));
    let omitted = writer.replace("context.source.as_str()", r#""FORM""#);
    assert!(
        shared_boundary_omits_source(&omitted),
        "gate flags a shared writer that drops the source binding"
    );
}

/// Same omission the audit-coverage gate pins on the shared boundary
/// (`context.source.as_str()` in `audit_write.rs`).
fn shared_boundary_omits_source(source: &str) -> bool {
    !source.contains("context.source.as_str()")
}

/// True when any `INSERT INTO audit_events` column list omits `source`.
fn raw_insert_omits_source(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    let needle = "insert into audit_events";
    let mut offset = 0;
    while let Some(at) = lower[offset..].find(needle) {
        let start = offset + at + needle.len();
        let tail = &lower[start..];
        let end = tail.find("values").unwrap_or(tail.len());
        if !tail[..end].contains("source") {
            return true;
        }
        offset = start + end;
        if offset >= lower.len() {
            break;
        }
    }
    false
}

async fn runtime_role_pool(owner_pool: &PgPool) -> PgPool {
    let options = owner_pool.connect_options().as_ref().clone();
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .unwrap()
}

async fn seed_user(pool: &PgPool) -> uuid::Uuid {
    sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind("Refresh User")
    .bind(Vec::<String>::from(["MECHANIC".to_owned()]))
    .bind(*OrgId::one().as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}
