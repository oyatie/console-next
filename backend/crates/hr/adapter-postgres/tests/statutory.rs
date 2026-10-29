#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod support;
#[path = "statutory/world.rs"]
mod world;
use console_hr_adapter_postgres::statutory::RecordFiling;
use console_hr_adapter_postgres::statutory::RegisterExport;
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeSet;
use support::{principal, tenant, user};
use uuid::Uuid;
use world::{complete, list, register, register_rules, world};

pub fn undo(version: i64) -> RecordFiling {
    serde_json::from_value(json!({"expected_version":version,"action":"UNDO"})).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_receipts_retry_undo_batch_evidence_and_refusals_are_audited(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let hr = &w.tenant.hr;
    let page = hr
        .insurance_filings(p.clone(), list(), register_rules(&pool).await)
        .await
        .unwrap();
    assert_eq!((page.total, page.pending), (4, 4));
    assert!(
        page.items
            .iter()
            .filter(|t| t.insurer == "NHIS")
            .all(|t| t.deadline_status == "HOLD")
    );
    assert!(
        page.items
            .iter()
            .filter(|t| t.insurer == "EI" || t.insurer == "IACI")
            .all(|t| t.deadline_status == "HOLD")
    );
    assert_eq!(
        page.items
            .iter()
            .find(|t| t.insurer == "NHIS")
            .unwrap()
            .due_date
            .as_deref(),
        Some("2026-09-14")
    );
    let rules = register_rules(&pool).await;
    let record = |body, key: &str| {
        hr.record_insurance_filing(
            p.clone(),
            (w.event, "ACQUIRE".into(), "NPS".into()),
            key.into(),
            body,
            rules.clone(),
        )
    };
    let first = record(complete(0), "first").await.unwrap();
    assert_eq!(first.version, 1);
    let replay = record(complete(0), "first").await.unwrap();
    assert_eq!(replay.version, 1);
    let reused = record(complete(1), "first").await.unwrap_err();
    assert_eq!(reused.code, "conflict");
    assert_eq!(
        reused.message,
        console_platform_db::idempotency::IDEMPOTENCY_KEY_REUSED
    );
    let stale = record(complete(0), "stale").await.unwrap_err();
    assert_eq!((stale.status.as_u16(), stale.code), (409, "filing_stale"));
    assert_eq!(record(undo(1), "undo").await.unwrap().version, 2);
    assert_eq!(record(complete(2), "again").await.unwrap().version, 3);
    // One agency batch number is evidence for several insurers/tasks.
    hr.record_insurance_filing(
        p.clone(),
        (w.event, "ACQUIRE".into(), "NHIS".into()),
        "batch".into(),
        complete(0),
        register_rules(&pool).await,
    )
    .await
    .unwrap();
    for (key, body) in [
        ("early", {
            let mut b = complete(3);
            b.completed_on = Some("2026-08-31".into());
            b
        }),
        ("future", {
            let mut b = complete(3);
            b.completed_on = Some("9999-12-31".into());
            b
        }),
        ("code", {
            let mut b = complete(3);
            b.loss_code = Some("unknown".into());
            b
        }),
    ] {
        let err = record(body, key).await.unwrap_err();
        assert_eq!(
            (err.status.as_u16(), err.code),
            (422, "filing_record_invalid")
        );
    }
    let absent = hr
        .record_insurance_filing(
            p.clone(),
            (Uuid::new_v4(), "ACQUIRE".into(), "NPS".into()),
            "absent".into(),
            complete(0),
            register_rules(&pool).await,
        )
        .await
        .unwrap_err();
    assert_eq!(absent.code, "filing_event_inactive");
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE org_id=$1")
            .bind(w.tenant.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 4);
    let refused: Vec<Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id=$1 AND action='insurance_filing.refused'",
    )
    .bind(w.tenant.org)
    .fetch_all(&pool)
    .await
    .unwrap();
    for code in [
        "filing_record_invalid",
        "filing_stale",
        "filing_event_inactive",
        "conflict",
    ] {
        assert!(refused.iter().any(|v| v["code"] == code));
    }
    assert_eq!(
        hr.insurance_filings(p, list(), register_rules(&pool).await)
            .await
            .unwrap()
            .pending,
        2
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_scope_tenant_and_own_record_guards_leave_no_receipt(pool: PgPool) {
    let w = world(&pool).await;
    let other = tenant(&pool).await;
    let other_user = user(&pool, other.org, None).await;
    assert_eq!(
        other
            .hr
            .insurance_filings(
                principal(other.org, other_user),
                list(),
                register_rules(&pool).await
            )
            .await
            .unwrap()
            .total,
        0
    );
    let err = other
        .hr
        .record_insurance_filing(
            principal(other.org, other_user),
            (w.event, "ACQUIRE".into(), "NPS".into()),
            "other".into(),
            complete(0),
            register_rules(&pool).await,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "filing_event_inactive");
    let reader = Principal::new(
        w.user,
        OrgId::from_uuid(w.tenant.org),
        BTreeSet::from([Role::Executive]),
        BranchScope::All,
    );
    let denied = w
        .tenant
        .hr
        .record_insurance_filing(
            reader,
            (w.event, "ACQUIRE".into(), "NPS".into()),
            "denied".into(),
            complete(0),
            register_rules(&pool).await,
        )
        .await
        .unwrap_err();
    assert_eq!(denied.status.as_u16(), 403);
    let me = user(&pool, w.tenant.org, Some(w.employee)).await;
    let own = w
        .tenant
        .hr
        .record_insurance_filing(
            principal(w.tenant.org, me),
            (w.event, "ACQUIRE".into(), "NPS".into()),
            "own".into(),
            complete(0),
            register_rules(&pool).await,
        )
        .await
        .unwrap_err();
    assert_eq!(own.code, "own_record_forbidden");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn statutory_register_is_dated_nonblocking_and_exports_all_rows_safely(pool: PgPool) {
    let w = world(&pool).await;
    let p = principal(w.tenant.org, w.user);
    let hr = &w.tenant.hr;
    assert_eq!(
        hr.worker_register(p.clone(), register(w.site, "2026-08-31"))
            .await
            .unwrap()
            .total,
        0
    );
    let page = hr
        .worker_register(p.clone(), register(w.site, "2026-09-02"))
        .await
        .unwrap();
    assert_eq!(page.total, 1);
    assert!(page.items[0].missing.contains(&"address".into()));
    assert_eq!(page.items[0].cells[9], "2026-09-01");
    let export = |format: &str, purpose: &str| {
        hr.export_worker_register(
            p.clone(),
            register(w.site, "2026-09-02"),
            RegisterExport {
                format: format.into(),
                export_purpose: Some(purpose.into()),
            },
        )
    };
    let err = export("xlsx", "").await.unwrap_err();
    assert_eq!(err.code, "export_purpose_required");
    let xlsx = export("xlsx", "AUDIT_RESPONSE").await.unwrap();
    assert_eq!(&xlsx.bytes[..2], b"PK");
    let book = console_platform_excel::umya_spreadsheet::reader::xlsx::read_reader(
        std::io::Cursor::new(xlsx.bytes),
        true,
    )
    .unwrap();
    let sheet = book.sheet(0).unwrap();
    assert_eq!(sheet.cell("A3").unwrap().value(), "=1+1");
    assert!(sheet.cell("A3").unwrap().formula().is_empty());
    assert_eq!(sheet.cell("D3").unwrap().value(), "1990-01-01");
    let printed: serde_json::Value =
        serde_json::from_slice(&export("pdf", "AUDIT_RESPONSE").await.unwrap().bytes).unwrap();
    assert_eq!(printed["items"][0]["cells"][1], "<Kim>&");
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    // A later assignment closes the first site's membership for current registers.
    sqlx::query("INSERT INTO employment_assignments (org_id,employee_id,legal_entity_id,valid_from,cause,command_id) VALUES ($1,$2,$3,'2026-10-01','MIGRATION',gen_random_uuid())")
        .bind(w.tenant.org).bind(w.employee).bind(w.entity).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        hr.worker_register(p.clone(), register(w.site, "2026-10-01"))
            .await
            .unwrap()
            .total,
        0
    );
    assert_eq!(
        hr.worker_register(p, register(w.site, "2026-09-02"))
            .await
            .unwrap()
            .total,
        1
    );
}
