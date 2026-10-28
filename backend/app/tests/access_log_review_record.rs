// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "access_log_review_record/chunks.rs"]
mod chunks;
#[path = "access_log_review_record/guards.rs"]
mod guards;
#[path = "access_log_review_flags/statements.rs"]
mod statements;
#[path = "access_log_review_flags/support.rs"]
mod support;

use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_access::{AccessService, log_review::record};
use console_platform_authz::Principal;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{arm, event};

fn principal(org: OrgId, user: UserId) -> Principal {
    Principal::new(user, org, Default::default(), BranchScope::All)
}

async fn reviewer(pool: &PgPool, org: OrgId, user: UserId) {
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
        .bind(org.as_uuid())
        .bind(user.as_uuid())
        .execute(pool)
        .await
        .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn start_is_concurrent_idempotent_frozen_and_tenant_isolated(pool: PgPool) {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "record").await;
    reviewer(&pool, org, user).await;
    let id = event(
        &pool,
        org,
        user,
        "employee.rrn_reveal",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    let rt = runtime_role_pool(&pool).await;
    let service = AccessService::new(rt.clone(), None);
    let p = principal(org, user);
    let (a, b) = tokio::join!(
        record::start(
            &service,
            p.clone(),
            "2026-09".into(),
            "review-start-key-1".into()
        ),
        record::start(
            &service,
            p.clone(),
            "2026-09".into(),
            "review-start-key-2".into()
        ),
    );
    let started = a.unwrap();
    assert_eq!(started, b.unwrap());
    assert_eq!(started["flags_seen"]["flagged_total"], 1);
    assert_eq!(started["state"], "open");
    assert_eq!(
        record::start(
            &service,
            p.clone(),
            "2026-09".into(),
            "review-start-key-1".into()
        )
        .await
        .unwrap(),
        started
    );
    let reused = record::start(
        &service,
        p.clone(),
        "2026-08".into(),
        "review-start-key-1".into(),
    )
    .await
    .unwrap_err();
    assert_eq!(reused.kind, console_platform_access::Refusal::Conflict);
    assert_eq!(reused.code, "conflict");
    assert_eq!(
        reused.message,
        console_platform_db::idempotency::IDEMPOTENCY_KEY_REUSED
    );
    event(
        &pool,
        org,
        user,
        "employee.rrn_reveal",
        "2026-09-01T02:00:00Z",
        json!({}),
    )
    .await;
    let page = record::frozen_page(&service, p.clone(), "2026-09".into(), None, 50)
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].event_id, id);
    let other = OrgId::new();
    let other_user = seed_org_and_super_admin(&pool, *other.as_uuid(), "other-record").await;
    reviewer(&pool, other, other_user).await;
    let error = record::frozen_page(
        &service,
        principal(other, other_user),
        "2026-09".into(),
        None,
        50,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "review_not_started");
    let start_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='access_log_review.start'",
    )
    .bind(org.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(start_rows, 1);
    let (evidence, versions): (Value, Value) = sqlx::query_as("SELECT after_snap,decision_snapshot FROM audit_events WHERE org_id=$1 AND action='access_log_review.start'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert!(
        versions
            .get("access_log_review.flag.every_download")
            .is_some()
    );
    assert_eq!(evidence["flag_set_sha256"].as_str().unwrap().len(), 64);
    assert!(started["flags_seen"].get("evidence").is_none());
    assert_eq!(
        started["flags_seen"]["rules"]["access_log_review.reason_due_business_days"],
        5
    );
    let refused: Vec<(String, String)> = sqlx::query_as("SELECT after_snap->>'code',outcome FROM audit_events WHERE org_id=$1 AND action='access_log_review.refused'")
        .bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
    assert_eq!(refused, [("conflict".into(), "DENIED".into())]);
    assert_eq!(
        record::frozen_page(&service, p, "2026-09".into(), None, 201)
            .await
            .unwrap_err()
            .code,
        "limit_out_of_range"
    );
    console_platform_test_support::grant_console_rt(
        &pool,
        &["GRANT UPDATE, DELETE ON audit_events TO console_rt"],
    )
    .await;
    let mut tx = arm(&rt, org).await;
    for sql in [
        "UPDATE audit_events SET after_snap='{}' WHERE action='access_log_review.start'",
        "DELETE FROM audit_events WHERE action='access_log_review.start'",
    ] {
        sqlx::query("SAVEPOINT append_only")
            .execute(tx.as_mut())
            .await
            .unwrap();
        let error = sqlx::query(sql).execute(tx.as_mut()).await.unwrap_err();
        let error = error.as_database_error().unwrap();
        assert_eq!(error.code().as_deref(), Some("P0001"));
        assert!(error.message().contains("append-only"));
        sqlx::query("ROLLBACK TO SAVEPOINT append_only")
            .execute(tx.as_mut())
            .await
            .unwrap();
    }
    tx.rollback().await.unwrap();
    let reads: Vec<Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='access_log.review_read'",
    )
    .bind(org.as_uuid())
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(reads.len(), 1);
    assert_eq!(reads[0]["subject_ids"], json!([user]));
    let signer: std::sync::Arc<dyn console_platform_audit_chain::SealSigner> = std::sync::Arc::new(
        console_platform_audit_chain::InMemoryEd25519Signer::generate().unwrap(),
    );
    let now = time::OffsetDateTime::now_utc() + time::Duration::minutes(2);
    let config = console_platform_audit_chain::SealConfig::default();
    assert!(
        console_platform_audit_chain::seal_org_once(&rt, org, &signer, now, &config)
            .await
            .unwrap()
            .is_some()
    );
    let report = console_platform_audit_chain::verify_org_chain(&rt, org, &signer, now, &config)
        .await
        .unwrap();
    assert_eq!(
        report.kind,
        console_platform_audit_chain::ChainReportKind::Ok
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn start_refusals_leave_no_review_and_each_write_one_denied_row(pool: PgPool) {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "record-refused").await;
    let service = AccessService::new(runtime_role_pool(&pool).await, None);
    let p = principal(org, user);
    let denied = record::start(
        &service,
        p.clone(),
        "2026-09".into(),
        "review-start-key-1".into(),
    )
    .await
    .unwrap_err();
    assert_eq!(denied.code, "access_denied");
    reviewer(&pool, org, user).await;
    for (period, code) in [
        ("2026-9", "period_invalid"),
        ("9998-12", "period_not_closed"),
    ] {
        assert_eq!(
            record::start(
                &service,
                p.clone(),
                period.into(),
                "review-start-key-1".into()
            )
            .await
            .unwrap_err()
            .code,
            code
        );
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT action,outcome,after_snap->>'code' FROM audit_events WHERE org_id=$1 AND target_type='access_log_review' ORDER BY created_at,id")
        .bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
    assert_eq!(
        rows,
        ["access_denied", "period_invalid", "period_not_closed"].map(|code| (
            "access_log_review.refused".into(),
            "DENIED".into(),
            code.into()
        ))
    );
}
