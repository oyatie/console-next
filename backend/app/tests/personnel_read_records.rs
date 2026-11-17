// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Every personnel read leaves one personnel access record, through the real
//! router as `console_rt`: the employment facts, the contract history, the
//! personnel card, an entry's history, the fixed-term service and the end
//! options as a lookup of that employee; the bulk correction preview and the
//! change request list as a list of the people whose values they show; and
//! the tenant-wide section sheet and the worker register as downloads that
//! state their purpose and are in the export log.
#[path = "support/http.rs"]
mod support;

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{Ctx, ctx, employee_body, structure, tenant, today_kst};
use uuid::Uuid;

/// The access records written so far: (id, action, target, details).
async fn records(pool: &PgPool, org: Uuid) -> Vec<(Uuid, String, String, Value)> {
    sqlx::query_as(
        "SELECT id, action, target_id, after_snap FROM audit_events \
         WHERE org_id = $1 AND after_snap ? 'self_read'",
    )
    .bind(org)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// `uri` read once: its status, body and the access records it wrote.
async fn read(
    c: &Ctx,
    pool: &PgPool,
    uri: &str,
) -> (StatusCode, Value, Vec<(String, String, Value)>) {
    send(c, pool, "GET", uri, None).await
}

/// One call of `method` on `uri`: its status, body and the access records it wrote.
async fn send(
    c: &Ctx,
    pool: &PgPool,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value, Vec<(String, String, Value)>) {
    let before: Vec<Uuid> = records(pool, c.org)
        .await
        .into_iter()
        .map(|r| r.0)
        .collect();
    let (status, body) = c.call(method, uri, body).await;
    let written = records(pool, c.org)
        .await
        .into_iter()
        .filter(|r| !before.contains(&r.0))
        .map(|(_, action, target, details)| (action, target, details))
        .collect();
    (status, body, written)
}

async fn export_logs(pool: &PgPool, org: Uuid) -> Vec<(String, String)> {
    sqlx::query_as("SELECT export_kind, export_purpose FROM excel_export_logs WHERE org_id = $1")
        .bind(org)
        .fetch_all(pool)
        .await
        .unwrap()
}

/// A tenant with its structure and one employee: the router, the employee id
/// and the head-office workplace id.
async fn one_employee(pool: &PgPool) -> (Ctx, String, String) {
    let (org, user) = tenant(pool, &["SUPER_ADMIN"]).await;
    let c = ctx(pool, org, user, &["SUPER_ADMIN"], None).await;
    let (_, workplace, branch, unit) = structure(&c).await;
    let (s, e) = c
        .call(
            "POST",
            "/api/v1/employees",
            Some(employee_body("READ-1", &branch, &unit)),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{e}");
    let id = e["employee"]["id"].as_str().unwrap().to_owned();
    (c, id, workplace)
}

/// `uri` read once as a lookup of employee `id` named `view`, its record
/// holding none of `value`.
async fn lookup(c: &Ctx, pool: &PgPool, uri: &str, id: &str, view: &str, value: &str) {
    let (status, body, written) = read(c, pool, uri).await;
    assert_eq!(status, StatusCode::OK, "{uri}: {body}");
    assert_eq!(written.len(), 1, "{uri}: {written:?}");
    let (action, target, details) = &written[0];
    assert_eq!((action.as_str(), target.as_str()), ("employee.read", id));
    assert_eq!(details["view"], view, "{uri}");
    assert_eq!(details["subject_ids"], json!([id]), "{uri}");
    assert!(
        !details.to_string().contains(value),
        "an access record names no values"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn each_personnel_read_leaves_one_access_record(pool: PgPool) {
    let (c, id, _) = one_employee(&pool).await;
    let org = c.org;
    let root = format!("/api/v1/employees/{id}");
    let family =
        json!({ "fields": { "relation": "SPOUSE", "name": "Sample Spouse", "cohabiting": true } });
    let (s, entry) = c
        .call("POST", &format!("{root}/records/family"), Some(family))
        .await;
    assert_eq!(s, StatusCode::CREATED, "{entry}");
    let entry = entry["id"].as_str().unwrap().to_owned();

    for (uri, view) in [
        (format!("{root}/employment-facts"), "employment_facts"),
        (format!("{root}/contracts"), "contracts"),
        (format!("{root}/records"), "records"),
        (
            format!("{root}/records/family/{entry}/history"),
            "record_history",
        ),
    ] {
        lookup(&c, &pool, &uri, &id, view, "Sample Spouse").await;
    }

    // The tenant-wide sheet is a download: no purpose, no rows.
    let (status, body, written) = read(&c, &pool, "/api/v1/employee-records/family").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["code"], "export_purpose_required", "{body}");
    assert_eq!(written.len(), 1, "{written:?}");
    assert_eq!(written[0].0, "employee.export_refused");
    assert!(export_logs(&pool, org).await.is_empty());

    let uri = "/api/v1/employee-records/family?export_purpose=INTERNAL_REVIEW";
    let (status, body, written) = read(&c, &pool, uri).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"][0]["entry"]["id"], entry.as_str());
    assert_eq!(written.len(), 1, "{written:?}");
    let (action, _, details) = &written[0];
    assert_eq!(action, "employee.export");
    assert_eq!(details["subject_ids"], json!([id]));
    assert_eq!(details["section"], "FAMILY");
    assert_eq!(details["export_purpose"], "INTERNAL_REVIEW");
    assert_eq!(details["row_count"], 1);
    assert!(!details.to_string().contains("Sample Spouse"));
    assert_eq!(
        export_logs(&pool, org).await,
        [("employee_records".to_owned(), "INTERNAL_REVIEW".to_owned())]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_fixed_term_read_is_a_lookup(pool: PgPool) {
    let (c, id, _) = one_employee(&pool).await;
    let uri = format!("/api/v1/employees/{id}/fixed-term");
    lookup(&c, &pool, &uri, &id, "fixed_term", &today_kst()).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_end_options_read_is_a_lookup(pool: PgPool) {
    let (c, id, _) = one_employee(&pool).await;
    let uri = format!("/api/v1/employees/{id}/end-options");
    lookup(&c, &pool, &uri, &id, "end_options", &today_kst()).await;
}

/// A refused download names what was asked for: the sheet and its section,
/// or the employee export.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_refused_download_names_its_view(pool: PgPool) {
    let (c, _, _) = one_employee(&pool).await;
    for (uri, view, section) in [
        (
            "/api/v1/employee-records/family",
            "employee_records",
            json!("FAMILY"),
        ),
        (
            "/api/v1/employees/export.csv",
            "employee_directory",
            Value::Null,
        ),
    ] {
        let (status, body, written) = read(&c, &pool, uri).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{uri}: {body}");
        assert_eq!(written.len(), 1, "{uri}: {written:?}");
        let (action, _, details) = &written[0];
        assert_eq!(action, "employee.export_refused");
        assert_eq!(details["view"], view, "{uri}");
        assert_eq!(details["section"], section, "{uri}");
    }
}

/// A bulk correction preview shows each selected person's stored values: one
/// list record naming them and the fields, never the values.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bulk_correction_preview_lists_the_people_it_shows(pool: PgPool) {
    let (c, id, _) = one_employee(&pool).await;
    let body = json!({
        "selection": { "filter": {} },
        "changes": { "phone": "010-9999-0000" },
        "reason_code": "DATA_ENTRY_ERROR",
    });
    let uri = "/api/v1/employees/corrections/bulk/preview";
    let (status, body, written) = send(&c, &pool, "POST", uri, Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let before = body["rows"][0]["fields"][0]["before"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(written.len(), 1, "{written:?}");
    let (action, _, details) = &written[0];
    assert_eq!(action, "employee.list_read");
    assert_eq!(details["view"], "bulk_correction_preview");
    assert_eq!(details["subject_ids"], json!([id]));
    assert_eq!(details["fields"], json!(["phone"]));
    assert_eq!(details["row_count"], 1);
    assert!(!details.to_string().contains(&before), "{before}");
}

/// HR's change request list shows what a correction asks for, a personal field
/// only as its mask: one list record naming the people they are about, never
/// the values.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_change_request_list_names_the_people_its_corrections_are_about(pool: PgPool) {
    let (c, id, _) = one_employee(&pool).await;
    let request = json!({
        "kind": "PROFILE_CORRECTION", "subject_type": "EMPLOYEE", "subject_id": id,
        "payload": { "changes": { "birth_date": "1990-01-02" } }, "reason_code": "DATA_ENTRY_ERROR",
    });
    let (status, body) = c
        .call("POST", "/api/v1/change-requests", Some(request))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body, written) = read(&c, &pool, "/api/v1/change-requests").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["items"][0]["payload"]["changes"]["birth_date"],
        "••••-••-••"
    );
    assert_eq!(written.len(), 1, "{written:?}");
    let (action, _, details) = &written[0];
    assert_eq!(action, "employee.list_read");
    assert_eq!(details["view"], "change_requests");
    assert_eq!(details["subject_ids"], json!([id]));
    assert!(!details.to_string().contains("1990-01-02"));
}

/// The worker register download is in the export log, and its record names
/// the log row.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_worker_register_download_is_in_the_export_log(pool: PgPool) {
    let (c, _, workplace) = one_employee(&pool).await;
    let uri = format!(
        "/api/v1/statutory/worker-register/export?workplace_id={workplace}&as_of={}\
         &format=pdf&export_purpose=INTERNAL_REVIEW",
        today_kst()
    );
    let (status, body, written) = read(&c, &pool, &uri).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(written.len(), 1, "{written:?}");
    let (action, _, details) = &written[0];
    assert_eq!(action, "employee.export");
    let logged: Vec<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT id, export_kind, export_purpose, file_name FROM excel_export_logs WHERE org_id = $1",
    )
    .bind(c.org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(logged.len(), 1, "{logged:?}");
    let (log_id, kind, purpose, file) = &logged[0];
    assert_eq!(
        (kind.as_str(), purpose.as_str(), file.as_str()),
        ("worker_register", "INTERNAL_REVIEW", "worker-register.json")
    );
    assert_eq!(details["export_log_id"], log_id.to_string());
}
