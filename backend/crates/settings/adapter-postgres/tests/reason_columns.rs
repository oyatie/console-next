//! The BW-07 columns as the runtime role (`console_rt`, RLS armed): a
//! code-only period lock is stored, its code is frozen like its reason, the
//! stored code columns feed the stats, and force removal of an archived
//! tenant clears its codes.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{AuditRequestContext, OrgId, TraceContext};
use console_platform_db::{DbError, with_org_conn};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use console_settings_adapter_postgres::PgSettingsStore;
use console_settings_application::Actor;
use console_settings_application::reason_codes::AddReasonCode;
use sqlx::PgPool;
use uuid::Uuid;

async fn tenant(pool: &PgPool) -> (Actor, PgSettingsStore) {
    let org = Uuid::new_v4();
    let user = seed_org_and_super_admin(pool, org, "reason-columns").await;
    let actor = Actor {
        org: OrgId::from_uuid(org),
        user,
    };
    (actor, PgSettingsStore::new(runtime_role_pool(pool).await))
}

async fn sql(store: &PgSettingsStore, org: OrgId, statement: &'static str) -> Result<(), String> {
    with_org_conn(store.pool(), org, move |tx| {
        Box::pin(async move {
            sqlx::query(statement)
                .bind(org.as_uuid())
                .execute(tx.as_mut())
                .await
                .map(|_| ())
                .map_err(DbError::Sqlx)
        })
    })
    .await
    .map_err(|e| match e {
        DbError::Sqlx(sqlx::Error::Database(db)) => db.code().unwrap_or_default().into_owned(),
        other => format!("{other:?}"),
    })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_code_only_period_lock_is_stored_frozen_and_counted(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let org = actor.org;
    for code in ["OTHER", "BOOKS_CLOSE"] {
        let insert = if code == "OTHER" {
            "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason_code, reason)
             VALUES ($1, 'payroll', '2026-08-01', '2026-08-31', 'OTHER', '설명')"
        } else {
            "INSERT INTO period_locks (org_id, domain, period_start, period_end, reason_code)
             VALUES ($1, 'payroll', '2026-09-01', '2026-09-30', 'BOOKS_CLOSE')"
        };
        sql(&store, org, insert).await.unwrap();
    }
    // Neither a code nor a note: refused (23514).
    let bare = "INSERT INTO period_locks (org_id, domain, period_start, period_end)
                VALUES ($1, 'payroll', '2026-10-01', '2026-10-31')";
    assert_eq!(sql(&store, org, bare).await, Err("23514".to_owned()));
    // The lock's code is frozen like its reason; a code-only unlock is fine.
    let recode = "UPDATE period_locks SET reason_code = 'TAX_FILING', unlocked_at = now(),
                  unlock_reason_code = 'AUDIT_FINDING' WHERE org_id = $1 AND reason IS NULL";
    assert_eq!(sql(&store, org, recode).await, Err("25006".to_owned()));
    let unlock = "UPDATE period_locks SET unlocked_at = now(), unlock_reason_code = 'AUDIT_FINDING'
                  WHERE org_id = $1 AND reason IS NULL";
    sql(&store, org, unlock).await.unwrap();

    let stats = store.reason_stats(org).await.unwrap();
    let lock = stats
        .iter()
        .find(|s| s.source == "period_locks.reason_code")
        .unwrap();
    assert_eq!((lock.total, lock.other, lock.other_rate), (2, 1, Some(0.5)));
    let unlocks = stats
        .iter()
        .find(|s| s.source == "period_locks.unlock_reason_code")
        .unwrap();
    assert_eq!(unlocks.codes.len(), 1);
    assert_eq!(
        (unlocks.codes[0].code.as_str(), unlocks.codes[0].count),
        ("AUDIT_FINDING", 1)
    );
    assert!(
        stats
            .iter()
            .filter(|s| !s.source.starts_with("period_locks"))
            .all(|s| s.total == 0)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn force_removal_of_an_archived_tenant_clears_its_codes(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    store
        .add_reason_code(
            actor,
            AddReasonCode {
                domain: "period_unlock".to_owned(),
                label_ko: "정리 대상".to_owned(),
                label_en: None,
                requires_note: false,
                involuntary: false,
                notice_required: false,
                sort: None,
            },
            (TraceContext::generate(), AuditRequestContext::default()),
            |_| Ok(()),
        )
        .await
        .unwrap();
    // rls-arming: ok owner-pool platform maintenance
    sqlx::query("UPDATE organizations SET status = 'ARCHIVED' WHERE id = $1")
        .bind(actor.org.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    // rls-arming: ok owner-pool platform maintenance
    let outcome: String = sqlx::query_scalar("SELECT platform_force_remove_organization($1)")
        .bind(actor.org.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(outcome, "removed");
    // rls-arming: ok owner-pool assertion
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM reason_codes WHERE org_id = $1")
        .bind(actor.org.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
