// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[path = "m4_waterfall_endpoints/ordering.rs"]
mod ordering;
#[path = "m4_waterfall_endpoints/payroll_and_nav.rs"]
mod payroll_and_nav;
#[path = "m4_waterfall_endpoints/setup.rs"]
mod setup;

use http::StatusCode;
use serde_json::json;
use setup::{code, harness, seed_employee, seed_org, seed_unit_and_branch};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn warnings_batch_register_facts_bulk_exit_counts_and_users_search(pool: PgPool) {
    let org_a = seed_org(&pool, "wf-main-a").await;
    let org_b = seed_org(&pool, "wf-main-b").await;
    let keys = harness::keys();
    let router = harness::router(&pool, &keys).await;

    let ops_a_id = harness::user(&pool, org_a, "SUPER_ADMIN").await;
    let admin_a_id = harness::user(&pool, org_a, "ADMIN").await;
    let ops_a = harness::Caller {
        service: router.clone(),
        token: Some(harness::token(&pool, &keys, org_a, ops_a_id, "SUPER_ADMIN").await),
    };
    let admin_a = harness::Caller {
        service: router,
        token: Some(harness::token(&pool, &keys, org_a, admin_a_id, "ADMIN").await),
    };

    let (branch_a, unit_a) = seed_unit_and_branch(&pool, org_a, "Ops Dept").await;
    let (branch_b, unit_b) = seed_unit_and_branch(&pool, org_b, "Foreign Dept").await;

    // #1 Namesake warnings capped at 20 + total_count; #10c DuplicateCandidate enrichment.
    let mut unit_emps = Vec::new();
    for i in 0..22 {
        let id = seed_employee(
            &pool,
            org_a,
            branch_a,
            unit_a,
            "Same Name",
            &format!("SN-{i:03}"),
            i + 1,
        )
        .await;
        unit_emps.push(id);
    }
    let (status, created) = ops_a
        .call(
            "POST",
            "/api/v1/employees",
            Some(json!({
                "idempotency_key": Uuid::new_v4().to_string(),
                "name": "Same Name",
                "org_unit_id": unit_a,
                "hire_date": "2026-06-01",
                "employment_type": "REGULAR",
                "phone": "+821055551111"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let created_id = Uuid::parse_str(created["employee"]["id"].as_str().unwrap()).unwrap();
    let warn = created["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["code"] == "same_name_in_unit")
        .expect("same_name_in_unit warning");
    assert_eq!(warn["employee_ids"].as_array().unwrap().len(), 20);
    assert_eq!(warn["matches"].as_array().unwrap().len(), 20);
    assert_eq!(warn["total_count"], json!(22));
    assert!(warn["matches"][0]["name"].is_string());

    // #10c DuplicateCandidate carries name, org_unit, hire_date.
    let (status, dup_err) = ops_a
        .call(
            "POST",
            "/api/v1/employees",
            Some(json!({
                "idempotency_key": Uuid::new_v4().to_string(),
                "name": "Same Name",
                "org_unit_id": unit_a,
                "hire_date": "2026-06-01",
                "employment_type": "REGULAR",
                "phone": "+821055551111"
            })),
        )
        .await;
    assert_eq!(
        (status, code(&dup_err)),
        (StatusCode::CONFLICT, "duplicate_candidate")
    );
    let refusal = &dup_err["error"]["refusals"][0];
    assert_eq!(refusal["name"], json!("Same Name"), "{dup_err}");
    assert_eq!(refusal["org_unit"], json!("Ops Dept"), "{dup_err}");
    assert_eq!(refusal["hire_date"], json!("2026-06-01"), "{dup_err}");

    // #2 POST /api/v1/employees/register-facts/query + GET /api/v1/employees?ids=...
    let foreign_emp = seed_employee(&pool, org_b, branch_b, unit_b, "Foreign", "FB-1", 1).await;
    let (status, denied) = admin_a
        .call(
            "POST",
            "/api/v1/employees/register-facts/query",
            Some(json!({ "ids": [created_id] })),
        )
        .await;
    assert_eq!(
        (status, code(&denied)),
        (StatusCode::FORBIDDEN, "forbidden")
    );

    let too_many: Vec<Uuid> = (0..501).map(|_| Uuid::new_v4()).collect();
    let (status, _) = ops_a
        .call(
            "POST",
            "/api/v1/employees/register-facts/query",
            Some(json!({ "ids": too_many })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (status, rf) = ops_a
        .call(
            "POST",
            "/api/v1/employees/register-facts/query",
            Some(json!({ "ids": [unit_emps[0], created_id, foreign_emp] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{rf}");
    assert_eq!(rf["items"].as_array().unwrap().len(), 2, "{rf}");
    let audit_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.list_read'",
    )
    .bind(org_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit_rows >= 1);

    let (status, by_ids) = ops_a
        .call(
            "GET",
            &format!("/api/v1/employees?ids={},{}", unit_emps[0], unit_emps[1]),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{by_ids}");
    assert_eq!(by_ids["items"].as_array().unwrap().len(), 2);

    // #3 POST /api/v1/hr/exit-cases/bulk (mixed batch + replay + mismatch + own_record_forbidden).
    sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2")
        .bind(unit_emps[2])
        .bind(ops_a_id.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let bulk_key = Uuid::new_v4().to_string();
    let send_bulk = |body_val: serde_json::Value, key: String| {
        let svc = ops_a.service.clone();
        let tok = ops_a.token.clone().unwrap();
        async move {
            let req = http::Request::builder()
                .method("POST")
                .uri("/api/v1/hr/exit-cases/bulk")
                .header(http::header::AUTHORIZATION, format!("Bearer {tok}"))
                .header(http::header::CONTENT_TYPE, "application/json")
                .header("Idempotency-Key", key)
                .body(axum::body::Body::from(body_val.to_string()))
                .unwrap();
            let resp = tower::ServiceExt::oneshot(svc, req).await.unwrap();
            let status = resp.status();
            let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
                .await
                .unwrap();
            let json: serde_json::Value =
                serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
            (status, json)
        }
    };
    let bulk_body = json!({
        "effective_exit_date": "2026-10-31",
        "site_manager_note": "Batch check",
        "exit_reason_code": "PERSONAL",
        "items": [
            { "employee_id": unit_emps[0] },
            { "employee_id": unit_emps[2] },
            { "employee_id": foreign_emp }
        ]
    });
    let (status, bulk_res) = send_bulk(bulk_body.clone(), bulk_key.clone()).await;
    assert_eq!(status, StatusCode::OK, "{bulk_res}");
    let results = bulk_res["results"].as_array().unwrap();
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["ok"], json!(true), "{bulk_res}");
    assert_eq!(results[1]["ok"], json!(false), "{bulk_res}");
    assert_eq!(
        results[1]["code"],
        json!("own_record_forbidden"),
        "{bulk_res}"
    );
    assert_eq!(results[2]["ok"], json!(false), "{bulk_res}");

    let (status, replay_res) = send_bulk(bulk_body, bulk_key.clone()).await;
    assert_eq!(status, StatusCode::OK, "{replay_res}");
    assert_eq!(replay_res, bulk_res);

    let (status, mismatch_res) = send_bulk(
        json!({
            "effective_exit_date": "2026-11-01",
            "site_manager_note": "Changed",
            "exit_reason_code": "PERSONAL",
            "items": [{ "employee_id": unit_emps[1] }]
        }),
        bulk_key,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{mismatch_res}");

    let too_many_exits: Vec<serde_json::Value> = (0..501)
        .map(|_| json!({ "employee_id": Uuid::new_v4() }))
        .collect();
    let (status, _) = ops_a
        .call(
            "POST",
            "/api/v1/hr/exit-cases/bulk",
            Some(json!({
                "effective_exit_date": "2026-10-31",
                "site_manager_note": "Too many",
                "items": too_many_exits
            })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // #10d Counts endpoints.
    let (status, exit_counts) = ops_a
        .call("GET", "/api/v1/hr/exit-cases/counts", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{exit_counts}");
    assert_eq!(exit_counts["open"], json!(1), "{exit_counts}");
    assert_eq!(exit_counts["reported"], json!(1), "{exit_counts}");

    let (status, cr_counts) = ops_a
        .call("GET", "/api/v1/change-requests/counts", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{cr_counts}");
    assert!(cr_counts["all"].is_i64());

    // #9 GET /api/v1/users?search=...
    let (status, users_res) = ops_a.call("GET", "/api/v1/users?search=SN-002", None).await;
    assert_eq!(status, StatusCode::OK, "{users_res}");
    assert_eq!(users_res["total"], json!(1), "{users_res}");

    // ILIKE escaping on /api/v1/employees and /api/v1/hr/exit-cases/counts.
    let lit_emp = seed_employee(
        &pool,
        org_a,
        branch_a,
        unit_a,
        "Lit 50%_Name\\X",
        "SN-50%_",
        99,
    )
    .await;
    for (term, expected) in [("%25", 1), ("_", 1), ("%5C", 1)] {
        let (status, res) = ops_a
            .call("GET", &format!("/api/v1/employees?search={term}"), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{res}");
        assert_eq!(res["total"], json!(expected), "employees search={term}");
    }
    let (status, ec_pct) = ops_a
        .call("GET", "/api/v1/hr/exit-cases/counts?search=%25", None)
        .await;
    assert_eq!(status, StatusCode::OK, "{ec_pct}");
    assert_eq!(ec_pct["open"], json!(0), "wildcard % must not match exit");
    let _ = lit_emp;
}
