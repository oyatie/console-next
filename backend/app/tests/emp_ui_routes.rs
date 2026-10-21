#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BE-EMP-UI over HTTP: the new routes are mounted behind the request
//! context, and their refusals reach the wire with status and code (the
//! service-level suites in console-hr-adapter-postgres prove the rest).

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
async fn the_emp_ui_routes_are_mounted_and_their_refusals_reach_the_wire(pool: PgPool) {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'EMP-UI HTTP')")
        .bind(org)
        .bind(format!("eu-{}", &org.simple().to_string()[..12]))
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
        service: service.clone(),
        token: Some(token(&pool, &keys, org, admin, "ADMIN").await),
    };
    let anonymous = Caller {
        service,
        token: None,
    };

    // 직급·직위·직책·직무: the ops account adds inline; ADMIN is refused.
    let (status, list) = ops.call("GET", "/api/v1/job-titles", None).await;
    assert_eq!(
        (status, list["can_manage"].clone()),
        (StatusCode::OK, json!(true)),
        "{list}"
    );
    let (status, added) = ops
        .call(
            "POST",
            "/api/v1/job-titles",
            Some(json!({"kind": "JOB", "label": "품질"})),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{added}");
    let (status, bad) = ops
        .call(
            "POST",
            "/api/v1/job-titles",
            Some(json!({"kind": "RANK", "label": "x"})),
        )
        .await;
    assert_eq!(
        (status, code(&bad)),
        // `kind` is an OpenAPI enum: a value outside it is refused on the wire before the
        // domain's own `job_title_kind_invalid` can answer.
        (StatusCode::UNPROCESSABLE_ENTITY, "validation")
    );
    let (status, denied) = admin
        .call(
            "POST",
            "/api/v1/job-titles",
            Some(json!({"kind": "JOB", "label": "물류"})),
        )
        .await;
    assert_eq!(
        (status, code(&denied)),
        (StatusCode::FORBIDDEN, "forbidden")
    );

    // Bulk 발령 preview.
    let preview = "/api/v1/employees/lifecycle-events/bulk/preview";
    let body = json!({"event_type": "PROMOTE", "employee_ids": [Uuid::new_v4()], "to_position": "과장",
                      "effective_date": "2027-03-01", "comment": "x"});
    let (status, denied) = admin.call("POST", preview, Some(body.clone())).await;
    assert_eq!(
        (status, code(&denied)),
        (StatusCode::FORBIDDEN, "forbidden")
    );
    let mut wrong = body.clone();
    wrong["event_type"] = json!("LEAVE_OF_ABSENCE");
    let (status, _) = ops.call("POST", preview, Some(wrong)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _) = anonymous.call("POST", preview, Some(body)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // 발령 공고.
    let notice =
        json!({"title": "공고", "notice_date": "2026-10-07", "event_ids": [Uuid::new_v4()]});
    let (status, _) = ops
        .send(
            "POST",
            "/api/v1/appointment-notices",
            Some(notice.clone()),
            false,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "the Idempotency-Key is required"
    );
    let (status, unknown) = ops
        .call("POST", "/api/v1/appointment-notices", Some(notice))
        .await;
    assert_eq!(
        (status, code(&unknown)),
        (StatusCode::NOT_FOUND, "not_found")
    );
    let (status, page) = ops.call("GET", "/api/v1/appointment-notices", None).await;
    assert_eq!((status, page["items"].clone()), (StatusCode::OK, json!([])));

    // 이관 확인.
    let run = Uuid::new_v4();
    for (method, uri, body) in [
        (
            "GET",
            format!("/api/v1/employees/import/{run}/reconcile"),
            None,
        ),
        (
            "GET",
            format!("/api/v1/employees/import/{run}/reconcile/rows"),
            None,
        ),
        (
            "PUT",
            format!("/api/v1/employees/import/{run}/reconcile/rows/k"),
            Some(json!({"state": "CONFIRMED"})),
        ),
        (
            "POST",
            format!("/api/v1/employees/import/{run}/signoff"),
            Some(json!({"expected_open_count": 0})),
        ),
    ] {
        let (status, _) = ops.call(method, &uri, body.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}");
        let (status, denied) = admin.call(method, &uri, body).await;
        assert_eq!(
            (status, code(&denied)),
            (StatusCode::FORBIDDEN, "forbidden"),
            "{method} {uri}"
        );
    }

    // 퇴직 사유 at the report.
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, \
         source_key, hire_date) VALUES ($1, 'Co', '한결', 'console', 'console', 1, $2, '2025-01-02') RETURNING id",
    )
    .bind(org)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    let report = json!({"employee_id": employee, "effective_exit_date": "2026-10-31",
                        "site_manager_note": "본인 사정", "exit_reason_code": "FIRED"});
    let (status, refused) = ops
        .call("POST", "/api/v1/hr/exit-cases", Some(report.clone()))
        .await;
    assert_eq!(
        (status, code(&refused)),
        (StatusCode::UNPROCESSABLE_ENTITY, "reason_code_invalid"),
        "{refused}"
    );
    let mut good = report;
    good["exit_reason_code"] = json!("PERSONAL");
    let (status, case) = ops.call("POST", "/api/v1/hr/exit-cases", Some(good)).await;
    assert_eq!(
        (status, case["exit_reason_code"].clone()),
        (StatusCode::CREATED, json!("PERSONAL")),
        "{case}"
    );
}
