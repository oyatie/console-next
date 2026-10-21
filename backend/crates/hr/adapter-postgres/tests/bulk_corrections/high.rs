//! High-risk fields in bulk: a BW-17 request per employee when another holder
//! exists; the sole holder's step-up bound to the preview, or refuse mode.

use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_platform_test_support::soft_passkey::passkey_service;
use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

use crate::support::{SECOND, world};
use crate::{SOLE, commit, count, owner, preview, request, row, selection, step_up, text};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn high_fields_wait_for_a_second_person_per_employee(pool: PgPool) {
    let w = world(&pool).await;
    for id in [w.in_a, w.in_b] {
        owner(
            &pool,
            "UPDATE employees SET hire_date = '2024-01-01' WHERE id = $1",
            id,
        )
        .await;
    }
    let body = selection(json!({ "hire_date": "2024-02-01", "job": "생산" }), &[]);
    let p = preview(&w, &body, SECOND).await;
    assert_eq!(p.counts.pending, 2);
    let paths: Vec<&str> = row(&p, w.in_a).fields.iter().map(|f| f.path).collect();
    assert_eq!(paths, vec!["SECOND_PERSON", "NOW"]);
    let done = commit(&w, &body, &p.preview_digest, "k-1", SECOND)
        .await
        .unwrap();
    assert!(
        done["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["pending_request_id"].is_string())
    );
    // The low field is written now, the hire date waits.
    assert_eq!(text(&pool, "job", w.in_a).await.as_deref(), Some("생산"));
    assert_eq!(
        text(&pool, "hire_date", w.in_a).await.as_deref(),
        Some("2024-01-01")
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM change_requests WHERE kind = 'PROFILE_CORRECTION' \
                     AND payload ? 'bulk_correction_id' AND payload -> 'changes' ? 'hire_date'"
        )
        .await,
        2
    );

    // Sole holder: the commit needs the step-up; refuse mode refuses the rows.
    let body = selection(json!({ "hire_date": "2024-03-01" }), &[]);
    let p = preview(&w, &body, SOLE).await;
    assert!(p.step_up_required);
    let err = commit(&w, &body, &p.preview_digest, "k-2", SOLE)
        .await
        .unwrap_err();
    assert_eq!(
        (err.status, err.code),
        (StatusCode::UNAUTHORIZED, "step_up_required")
    );
    let refuse = SecondPersonContext {
        sole_holder_refuse: true,
        ..SOLE
    };
    let p = preview(&w, &body, refuse).await;
    assert_eq!(p.counts.refused, 2);
    assert_eq!(
        row(&p, w.in_a).code,
        Some("employee_correction_sole_holder_refused")
    );
    let err = commit(&w, &body, &p.preview_digest, "k-3", refuse)
        .await
        .unwrap_err();
    assert_eq!(err.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_sole_holder_commits_high_fields_with_a_step_up_bound_to_the_preview(pool: PgPool) {
    let w = world(&pool).await;
    owner(
        &pool,
        "UPDATE employees SET hire_date = '2024-01-01' WHERE id = $1",
        w.in_a,
    )
    .await;
    let body = json!({
        "rows": [{ "employee_id": w.in_a, "changes": { "hire_date": "2024-01-15" } }],
        "reason_code": "DATA_ENTRY_ERROR",
    });
    let p = preview(&w, &body, SOLE).await;
    let mut key = step_up::enroll(&pool, &w, w.hr_one).await;
    let envelope = step_up::sign(&pool, &mut key, p.preview_id, &p.preview_digest).await;
    let mut signed = body.clone();
    signed["preview_digest"] = json!(p.preview_digest);
    let mut signed = request(signed);
    signed.step_up = Some(envelope);
    let done =
        w.hr.commit_bulk_correction(
            w.hr(w.hr_one),
            &passkey_service(),
            Some("bulk-correction-sole".into()),
            signed,
            SOLE,
        )
        .await
        .unwrap();
    assert_eq!(done["review_required"], json!(true));
    assert_eq!(
        text(&pool, "hire_date", w.in_a).await.as_deref(),
        Some("2024-01-15")
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM employee_corrections WHERE review_required AND batch_id IS NOT NULL").await,
        1
    );
}
