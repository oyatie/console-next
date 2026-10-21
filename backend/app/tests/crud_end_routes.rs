#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! CRUD over HTTP: the end-options reads and the direct 부서 writes are
//! mounted behind the request context, Cedar `org_unit_manage` refuses a
//! caller without the tenant-wide org-change door (403, nothing written), and
//! the 퇴직 report's refusals reach the wire with their codes. The adapter
//! suites (entity org_end/record_end, hr emp_ui crud_ends) prove the rest.

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[path = "support/go_live.rs"]
mod go_live;
#[path = "emp_ui_routes/harness.rs"]
mod harness;

use harness::{Caller, keys, router, token, user};

fn code(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or_default()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_crud_routes_are_mounted_decided_in_cedar_and_refuse_on_the_wire(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'CRUD HTTP')")
        .bind(org)
        .bind(format!("crud-{}", &org.simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    go_live::go_live(&pool, org).await;
    let keys = keys();
    let service = router(&pool, &keys).await;
    let (ops, admin) = (
        user(&pool, org, "SUPER_ADMIN").await,
        user(&pool, org, "ADMIN").await,
    );
    let ops = Caller {
        service: service.clone(),
        token: Some(token(&pool, &keys, org, ops, "SUPER_ADMIN").await),
    };
    let admin = Caller {
        service,
        token: Some(token(&pool, &keys, org, admin, "ADMIN").await),
    };
    let unit = Uuid::new_v4();
    let pinned = json!({ "expected_version": 1 });

    // Without the tenant-wide org-change door Cedar refuses every direct 부서 write.
    for (method, path, body) in [
        (
            "POST",
            format!("/api/v1/org-structure/units/{unit}/erase"),
            pinned.clone(),
        ),
        (
            "POST",
            format!("/api/v1/org-structure/units/{unit}/dissolve"),
            pinned.clone(),
        ),
        (
            "PUT",
            format!("/api/v1/org-structure/units/{unit}/details"),
            json!({ "expected_version": 1, "code": "X-1" }),
        ),
    ] {
        let (status, body) = admin.call(method, &path, Some(body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
    }
    // The ops account passes Cedar; an unknown unit is 404, never a 500.
    let (status, body) = ops
        .call(
            "POST",
            &format!("/api/v1/org-structure/units/{unit}/erase"),
            Some(pinned),
        )
        .await;
    assert_eq!(
        (status, code(&body)),
        (StatusCode::NOT_FOUND, "org_unit_not_found"),
        "{body}"
    );
    let (status, body) = ops
        .call(
            "GET",
            &format!("/api/v1/org-structure/units/{unit}/end-options"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    // A person: the end-options read, and the 퇴직 report's refusals on the wire.
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, \
         source_key, hire_date) VALUES ($1, 'Co', '한결', 'console', 'console', 1, $2, '2025-01-02') RETURNING id",
    )
    .bind(org)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let (status, end) = ops
        .call(
            "GET",
            &format!("/api/v1/employees/{employee}/end-options"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{end}");
    assert_eq!(
        (end["phase"].clone(), end["cancel_route"].clone()),
        (json!("OPERATING"), json!("VOID"))
    );
    assert_eq!(end["exit"]["allowed"], json!(true));
    let early = json!({"employee_id": employee, "effective_exit_date": "2024-12-31", "site_manager_note": "본인 사정"});
    let (status, body) = ops.call("POST", "/api/v1/hr/exit-cases", Some(early)).await;
    assert_eq!(
        (status, code(&body)),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "effective_date_before_hire"
        ),
        "{body}"
    );
    let cases: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employee_exit_cases WHERE employee_id = $1")
            .bind(employee)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(cases, 0, "a refused report writes nothing");
}
