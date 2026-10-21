//! BE-EMP-UI (EMP-UI 13): a refused grid row names every refusal with its
//! field, so the grid marks each cell, not only the first.

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::support::{SECOND, world};
use super::{preview, row, updated_at};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_refused_row_lists_each_failing_field_and_never_a_good_one(pool: PgPool) {
    let w = world(&pool).await;
    let ghost = Uuid::new_v4();
    // in_a already holds E-1, so in_b's E-1 meets the record check whatever
    // order the rows are planned in.
    sqlx::query("UPDATE employees SET employee_number = 'E-1' WHERE id = $1")
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    let pin = updated_at(&pool, w.in_a).await;
    let body = json!({
        "rows": [
            { "employee_id": w.in_a, "changes": { "work_email": "a@corp.example" } },
            { "employee_id": w.in_b, "changes": {
                "employee_number": "E-1", "exit_date": "2024-01-01",
                "birth_date": "1899-01-01", "work_email": "ok@corp.example", "company": "X" } },
            { "employee_id": ghost, "changes": { "work_email": "x@corp.example" } },
        ],
        "reason_code": "DATA_ENTRY_ERROR",
    });
    let p = preview(&w, &body, SECOND).await;
    let refused = row(&p, w.in_b);
    assert_eq!(refused.outcome, "REFUSED");
    let fields: Vec<Option<&str>> = refused
        .refusals
        .iter()
        .map(|r| r.field.as_deref())
        .collect();
    for field in ["birth_date", "company", "employee_number", "exit_date"] {
        assert!(fields.contains(&Some(field)), "{field}: {fields:?}");
    }
    assert!(
        !fields.contains(&Some("work_email")),
        "a good value is never refused"
    );
    let code_of = |f: &str| {
        refused
            .refusals
            .iter()
            .find(|r| r.field.as_deref() == Some(f))
            .unwrap()
            .code
    };
    assert_eq!(code_of("employee_number"), "employee_number_in_use");
    assert_eq!(code_of("exit_date"), "exit_date_needs_exit");
    assert_eq!(code_of("birth_date"), "validation");
    // The row keeps its first refusal for older readers.
    assert_eq!(refused.code, Some(refused.refusals[0].code));
    // A row-level refusal names no field.
    let unknown = row(&p, ghost);
    assert_eq!(
        unknown
            .refusals
            .iter()
            .map(|r| (r.field.clone(), r.code))
            .collect::<Vec<_>>(),
        [(None, "not_found")]
    );
    assert_eq!((p.counts.change, p.counts.refused), (1, 2));
    // A stale pin is the row's alone (no per-field noise).
    let stale = json!({
        "rows": [{ "employee_id": w.in_a, "changes": { "employee_number": "E-9", "birth_date": "1899-01-01" },
                   "expected_updated_at": pin }],
        "reason_code": "DATA_ENTRY_ERROR",
    });
    sqlx::query("UPDATE employees SET updated_at = updated_at + interval '1 second' WHERE id = $1")
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    let p = preview(&w, &stale, SECOND).await;
    let r = row(&p, w.in_a);
    assert_eq!(r.refusals.len(), 1);
    assert_eq!(
        (r.refusals[0].field.as_deref(), r.refusals[0].code),
        (None, "stale_record")
    );
}
