#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-27: bulk 정정 through MR-8's ledger, run as the runtime role
//! `console_rt`: server-side selection, preview with exact counts, per-row
//! preconditions, one job per commit.

mod high;
mod per_field;
mod step_up;
#[path = "../support/mod.rs"]
mod support;

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::bulk_corrections::{
    BulkCorrectionPreview, BulkCorrectionPreviewRow, BulkCorrectionRequest,
};
use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use support::{SECOND, World, world};

const SOLE: SecondPersonContext = SecondPersonContext {
    other_eligible_holders: 0,
    routed: true,
    sole_holder_refuse: false,
};

/// Owner-side fixture write (triggers off, like the support fixture).
async fn owner(pool: &PgPool, sql: &'static str, id: Uuid) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query(sql)
        .bind(id)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

fn request(body: Value) -> BulkCorrectionRequest {
    serde_json::from_value(body).unwrap()
}

fn selection(changes: Value, exclude: &[Uuid]) -> Value {
    json!({
        "selection": { "filter": {}, "exclude_ids": exclude },
        "changes": changes,
        "reason_code": "DATA_ENTRY_ERROR",
    })
}

async fn preview(w: &World, body: &Value, holders: SecondPersonContext) -> BulkCorrectionPreview {
    w.hr.preview_bulk_correction(w.hr(w.hr_one), request(body.clone()), holders)
        .await
        .unwrap()
}

async fn commit(
    w: &World,
    body: &Value,
    digest: &str,
    key: &str,
    holders: SecondPersonContext,
) -> Result<Value, HrError> {
    let mut body = body.clone();
    body["preview_digest"] = json!(digest);
    w.hr.commit_bulk_correction(
        w.hr(w.hr_one),
        &passkey_service(),
        Some(format!("bulk-correction-{key}")),
        request(body),
        holders,
    )
    .await
}

fn row(p: &BulkCorrectionPreview, id: Uuid) -> &BulkCorrectionPreviewRow {
    p.rows.iter().find(|r| r.employee_id == id).unwrap()
}

async fn text(pool: &PgPool, column: &str, id: Uuid) -> Option<String> {
    sqlx::query_scalar("SELECT to_jsonb(e) ->> $2 FROM employees e WHERE id = $1")
        .bind(id)
        .bind(column)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn count(pool: &PgPool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn updated_at(pool: &PgPool, id: Uuid) -> String {
    let at: OffsetDateTime = sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
    at.format(&Rfc3339).unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_selection_previews_exact_counts_and_commits_one_job(pool: PgPool) {
    let w = world(&pool).await;
    owner(
        &pool,
        "UPDATE employees SET job = '현장' WHERE id = $1",
        w.in_a,
    )
    .await;
    owner(
        &pool,
        "UPDATE employees SET job = '설비' WHERE id = $1",
        w.in_b,
    )
    .await;
    let body = selection(json!({ "job": " 설비 " }), &[]);
    let p = preview(&w, &body, SECOND).await;
    assert_eq!(
        (p.counts.selected, p.counts.change, p.counts.unchanged),
        (2, 1, 1)
    );
    assert!(!p.step_up_required);
    let a = row(&p, w.in_a);
    assert_eq!(a.outcome, "CHANGE");
    assert_eq!(
        (a.fields[0].before.as_deref(), a.fields[0].after.as_deref()),
        (Some("현장"), Some("설비"))
    );
    assert_eq!(row(&p, w.in_b).outcome, "UNCHANGED");
    // The preview wrote nothing.
    assert_eq!(text(&pool, "job", w.in_a).await.as_deref(), Some("현장"));

    let done = commit(&w, &body, &p.preview_digest, "k-1", SECOND)
        .await
        .unwrap();
    assert_eq!(done["bulk_correction_id"], json!(p.preview_id));
    assert_eq!(done["counts"]["change"], json!(1));
    assert_eq!(text(&pool, "job", w.in_a).await.as_deref(), Some("설비"));
    let ledger: Vec<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT employee_id, batch_id FROM employee_corrections WHERE field = 'job'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(ledger, vec![(w.in_a, Some(p.preview_id))]);
    let job =
        w.hr.bulk_correction_job(w.hr(w.hr_one), p.preview_id)
            .await
            .unwrap();
    assert_eq!(
        (job.fields, job.counts.selected, job.counts.unchanged),
        (vec!["job".to_owned()], 2, 1)
    );

    // The same key replays the stored result; nothing is written twice.
    let replay = commit(&w, &body, &p.preview_digest, "k-1", SECOND)
        .await
        .unwrap();
    assert_eq!(replay, done);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM employee_correction_batches").await,
        1
    );
    // A new key on the old preview meets the changed rows.
    let stale = commit(&w, &body, &p.preview_digest, "k-2", SECOND)
        .await
        .unwrap_err();
    assert_eq!(
        (stale.status, stale.code),
        (StatusCode::CONFLICT, "rows_changed_since_preview")
    );
    // The refusal lists every row as it stands now: in_a is UNCHANGED now.
    let now = stale.refusals.unwrap();
    let now = now.as_array().unwrap();
    assert_eq!(now.len(), 2);
    assert!(now.iter().all(|r| r["outcome"] == json!("UNCHANGED")));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exclusions_and_filters_narrow_the_server_selection(pool: PgPool) {
    let w = world(&pool).await;
    let body = selection(json!({ "work_email": "team@corp.example" }), &[w.in_b]);
    let p = preview(&w, &body, SECOND).await;
    assert_eq!(p.counts.selected, 1);
    assert_eq!(p.rows[0].employee_id, w.in_a);
    // EXITED people are selected only when asked for.
    owner(
        &pool,
        "UPDATE employees SET employment_status = 'EXITED' WHERE id = $1",
        w.in_a,
    )
    .await;
    let p = preview(
        &w,
        &selection(json!({ "work_email": "x@corp.example" }), &[]),
        SECOND,
    )
    .await;
    assert_eq!((p.counts.selected, p.rows[0].employee_id), (1, w.in_b));
    let mut exited = selection(json!({ "work_email": "x@corp.example" }), &[]);
    exited["selection"]["filter"]["status"] = json!("EXITED");
    assert_eq!(
        preview(&w, &exited, SECOND).await.rows[0].employee_id,
        w.in_a
    );
    // A misspelt filter is refused, never read as "everyone".
    let typo = json!({ "selection": { "filter": { "org_unit": "x" } }, "changes": { "job": "a" }, "reason_code": "R" });
    assert!(serde_json::from_value::<BulkCorrectionRequest>(typo).is_err());
    // A shared value that cannot be written is the request's error.
    let bad =
        w.hr.preview_bulk_correction(
            w.hr(w.hr_one),
            request(selection(json!({ "org_unit": "x" }), &[])),
            SECOND,
        )
        .await
        .unwrap_err();
    assert_eq!(bad.code, "employee_correction_unavailable");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn grid_rows_refuse_per_row_preconditions_and_write_the_rest(pool: PgPool) {
    let w = world(&pool).await;
    let pin = updated_at(&pool, w.in_a).await;
    let body = json!({
        "rows": [
            { "employee_id": w.in_a, "changes": { "employee_number": "E-1" }, "expected_updated_at": pin },
            { "employee_id": w.in_b, "changes": { "employee_number": "E-1", "exit_date": "2024-01-01" } },
        ],
        "reason_code": "DATA_ENTRY_ERROR",
    });
    let p = preview(&w, &body, SECOND).await;
    // in_b fails a precondition (an active record has no 퇴직일; or the
    // number in_a takes in this batch), and a refused row reserves nothing.
    assert_eq!(row(&p, w.in_a).outcome, "CHANGE");
    let refused = row(&p, w.in_b);
    assert_eq!(refused.outcome, "REFUSED");
    assert!(matches!(
        refused.code,
        Some("employee_number_in_use" | "exit_date_needs_exit")
    ));
    assert_eq!((p.counts.change, p.counts.refused), (1, 1));
    let done = commit(&w, &body, &p.preview_digest, "k-1", SECOND)
        .await
        .unwrap();
    assert_eq!(done["counts"]["refused"], json!(1));
    assert_eq!(
        text(&pool, "employee_number", w.in_a).await.as_deref(),
        Some("E-1")
    );
    assert_eq!(text(&pool, "employee_number", w.in_b).await, None);

    // A grid row pinned before that commit is refused on its own pin.
    let again = json!({
        "rows": [{ "employee_id": w.in_a, "changes": { "employee_number": "E-2" }, "expected_updated_at": pin }],
        "reason_code": "DATA_ENTRY_ERROR",
    });
    let p = preview(&w, &again, SECOND).await;
    assert_eq!(row(&p, w.in_a).code, Some("stale_record"));
    let err = commit(&w, &again, &p.preview_digest, "k-2", SECOND)
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_job_text_correction_unbinds_the_job_catalog_entry(pool: PgPool) {
    let w = world(&pool).await;
    let job: Uuid = sqlx::query_scalar(
        "INSERT INTO job_titles (org_id, kind, label, created_by) VALUES ($1, 'JOB', '설비 관리', $2) RETURNING id",
    )
    .bind(w.org)
    .bind(w.hr_one)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE employees SET job = '설비 관리', job_id = $2 WHERE id = $1")
        .bind(w.in_a)
        .bind(job)
        .execute(&pool)
        .await
        .unwrap();
    let body = json!({
        "rows": [{ "employee_id": w.in_a, "changes": { "job": "설비 보전" } }],
        "reason_code": "DATA_ENTRY_ERROR",
    });
    let p = preview(&w, &body, SECOND).await;
    commit(&w, &body, &p.preview_digest, "k", SECOND)
        .await
        .unwrap();
    assert_eq!(text(&pool, "job_id", w.in_a).await, None);
}
