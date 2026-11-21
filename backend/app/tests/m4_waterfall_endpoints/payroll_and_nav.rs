// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::setup::{grant_tenant_pay_view, harness, seed_employee, seed_org, seed_unit_and_branch};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_chart_change_request_names_unit_position_and_payroll_run_filters_work(pool: PgPool) {
    let org_a = seed_org(&pool, "wf-nav-a").await;
    let org_b = seed_org(&pool, "wf-nav-b").await;

    let keys = harness::keys();
    let router = harness::router(&pool, &keys).await;
    let ops_a_id = harness::user(&pool, org_a, "SUPER_ADMIN").await;
    let ops_b_id = harness::user(&pool, org_b, "SUPER_ADMIN").await;
    grant_tenant_pay_view(&pool, org_a, ops_a_id).await;

    let ops_a = harness::Caller {
        service: router.clone(),
        token: Some(harness::token(&pool, &keys, org_a, ops_a_id, "SUPER_ADMIN").await),
    };
    let ops_b = harness::Caller {
        service: router,
        token: Some(harness::token(&pool, &keys, org_b, ops_b_id, "SUPER_ADMIN").await),
    };

    let (branch_a, unit_a) = seed_unit_and_branch(&pool, org_a, "Engineering").await;
    let (branch_b, unit_b) = seed_unit_and_branch(&pool, org_b, "Other Unit").await;

    // #7 Unit position past 200 members (seed 210 in unit_a + 1 in org_b).
    let mut seeded_ids = Vec::with_capacity(210);
    for i in 0..210 {
        let id = seed_employee(
            &pool,
            org_a,
            branch_a,
            unit_a,
            &format!("Member {i:03}"),
            &format!("E-{i:04}"),
            i + 1,
        )
        .await;
        seeded_ids.push(id);
    }
    let foreign_emp = seed_employee(&pool, org_b, branch_b, unit_b, "Foreign Emp", "F-1", 1).await;

    // #5 Org chart exposes total & truncated flags.
    let (status, chart) = ops_a.call("GET", "/api/v1/hr/org-chart", None).await;
    assert_eq!(status, StatusCode::OK, "{chart}");
    assert_eq!(chart["truncated"], json!(false), "{chart}");
    assert_eq!(chart["total"], json!(210), "{chart}");

    // Fetch authoritative order via GET /employees?org_unit_id=...&limit=250.
    let (status, list) = ops_a
        .call(
            "GET",
            &format!("/api/v1/employees?org_unit_id={unit_a}&limit=500"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 210);
    let target_205 = items[205]["id"].as_str().unwrap();
    let expected_prev = items[204]["id"].as_str().unwrap();
    let expected_next = items[206]["id"].as_str().unwrap();

    let (status, pos) = ops_a
        .call(
            "GET",
            &format!("/api/v1/employees/{target_205}/unit-position"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pos}");
    assert_eq!(pos["org_unit_id"], json!(unit_a.to_string()));
    assert_eq!(pos["index"], json!(206)); // 1-based
    assert_eq!(pos["total"], json!(210));
    assert_eq!(pos["prev_id"], json!(expected_prev));
    assert_eq!(pos["next_id"], json!(expected_next));

    let (status, _) = ops_a
        .call(
            "GET",
            &format!("/api/v1/employees/{foreign_emp}/unit-position"),
            None,
        )
        .await;
    assert!(
        matches!(status, StatusCode::NOT_FOUND | StatusCode::FORBIDDEN),
        "cross-tenant unit-position must be denied: {status}"
    );

    // #6 Change requests include subject_name & subject_number via tenant-scoped LEFT JOIN.
    let target_emp = seeded_ids[5];
    let (status, cr) = ops_a
        .call(
            "POST",
            "/api/v1/change-requests",
            Some(json!({
                "kind": "PROFILE_CORRECTION",
                "subject_type": "EMPLOYEE",
                "subject_id": target_emp,
                "reason_code": "OTHER",
                "note": "fix work email",
                "payload": { "changes": { "work_email": "member005@example.com" } }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{cr}");
    assert_eq!(cr["subject_name"], json!("Member 005"), "{cr}");
    assert_eq!(cr["subject_number"], json!("E-0005"), "{cr}");

    let (status, cr_list) = ops_a.call("GET", "/api/v1/change-requests", None).await;
    assert_eq!(status, StatusCode::OK, "{cr_list}");
    assert_eq!(cr_list["items"][0]["subject_name"], json!("Member 005"));
    assert_eq!(cr_list["items"][0]["subject_number"], json!("E-0005"));

    let (status, cr_b) = ops_b.call("GET", "/api/v1/change-requests", None).await;
    assert_eq!(status, StatusCode::OK, "{cr_b}");
    assert_eq!(cr_b["items"], json!([]));

    // #8 Payroll runs optional filters (pay_group_id, legal_entity_id).
    let entity_1: Uuid = sqlx::query_scalar(
        "INSERT INTO legal_entities (org_id, biz_kind, created_change_mode) \
         VALUES ($1, 'CORPORATION', 'MIGRATION') RETURNING id",
    )
    .bind(org_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    let entity_2: Uuid = sqlx::query_scalar(
        "INSERT INTO legal_entities (org_id, biz_kind, created_change_mode) \
         VALUES ($1, 'CORPORATION', 'MIGRATION') RETURNING id",
    )
    .bind(org_a)
    .fetch_one(&pool)
    .await
    .unwrap();
    let pg_insert = "INSERT INTO pay_groups \
        (org_id, id, legal_entity_id, name, pay_date_rule, base_period, variable_period, proration, channel, sensitive, pay_basis_allowed) \
        VALUES ($1, $2, $3, $4, '{\"day\":\"LAST_DAY\",\"month_offset\":0,\"non_business_day\":\"PREVIOUS\"}'::jsonb, \
                '{\"start_day\":\"FIRST\",\"month_offset\":0}'::jsonb, \
                '{\"start_day\":16,\"month_offset\":-1}'::jsonb, 'CALENDAR_DAYS', 'ATTESTATION_ONLY', false, ARRAY['MONTHLY']) \
        RETURNING id";
    let pg_1: Uuid = sqlx::query_scalar(pg_insert)
        .bind(org_a)
        .bind(Uuid::new_v4())
        .bind(entity_1)
        .bind("PG1")
        .fetch_one(&pool)
        .await
        .unwrap();
    let pg_2: Uuid = sqlx::query_scalar(pg_insert)
        .bind(org_a)
        .bind(Uuid::new_v4())
        .bind(entity_2)
        .bind("PG2")
        .fetch_one(&pool)
        .await
        .unwrap();
    let run_1 = Uuid::new_v4();
    let run_2 = Uuid::new_v4();
    for (run_id, pg_id, label) in [(run_1, pg_1, "Run 1"), (run_2, pg_2, "Run 2")] {
        sqlx::query(
            "INSERT INTO payroll_draft_runs \
             (id, org_id, pay_group_id, kind, attribution_month, pay_date, period_start, period_end, variable_period_start, variable_period_end, source_label, status, calculation_enabled, created_by) \
             VALUES ($1, $2, $3, 'REGULAR', '2026-08-01', '2026-08-25', '2026-08-01', '2026-08-31', '2026-07-16', '2026-08-15', $4, 'STAGED', false, $5)",
        )
        .bind(run_id).bind(org_a).bind(pg_id).bind(label).bind(*ops_a_id.as_uuid())
        .execute(&pool).await.unwrap();
    }

    let (status, by_pg) = ops_a
        .call(
            "GET",
            &format!("/api/v1/payroll/runs?pay_group_id={pg_1}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{by_pg}");
    assert_eq!(by_pg["total"], json!(1), "{by_pg}");
    assert_eq!(by_pg["items"][0]["id"], json!(run_1.to_string()));

    let (status, by_le) = ops_a
        .call(
            "GET",
            &format!("/api/v1/payroll/runs?legal_entity_id={entity_2}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{by_le}");
    assert_eq!(by_le["total"], json!(1), "{by_le}");
    assert_eq!(by_le["items"][0]["id"], json!(run_2.to_string()));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn org_chart_hierarchy_ordering_and_tied_unit_position_parity(pool: PgPool) {
    let org = seed_org(&pool, "wf-order").await;
    let keys = harness::keys();
    let router = harness::router(&pool, &keys).await;
    let ops_id = harness::user(&pool, org, "SUPER_ADMIN").await;
    let ops = harness::Caller {
        service: router,
        token: Some(harness::token(&pool, &keys, org, ops_id, "SUPER_ADMIN").await),
    };

    let (branch, unit_zeta) = seed_unit_and_branch(&pool, org, "Zeta Unit").await;
    let (_, unit_alpha) = seed_unit_and_branch(&pool, org, "Alpha Unit").await;

    // Seed employees with explicit companies, units, positions, and names that do not match UUID order.
    let mut ids = Vec::new();
    for (company, unit, name, pos, num) in [
        ("Beta Co", unit_zeta, "Zed", "Lead", "O-1"),
        ("Alpha Co", unit_zeta, "Bob", "Staff", "O-2"),
        ("Alpha Co", unit_alpha, "Carl", "Manager", "O-3"),
        ("Alpha Co", unit_alpha, "Alice", "Associate", "O-4"),
    ] {
        let id = seed_employee(&pool, org, branch, unit, name, num, 1).await;
        sqlx::query("UPDATE employees SET company = $2, position = $3 WHERE id = $1")
            .bind(id)
            .bind(company)
            .bind(pos)
            .execute(&pool)
            .await
            .unwrap();
        ids.push(id);
    }

    let (status, chart) = ops.call("GET", "/api/v1/hr/org-chart", None).await;
    assert_eq!(status, StatusCode::OK, "{chart}");
    let companies: Vec<&str> = chart["companies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["company"].as_str().unwrap())
        .collect();
    assert_eq!(companies, vec!["Alpha Co", "Beta Co"]);
    let alpha_units: Vec<&str> = chart["companies"][0]["units"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["name"].as_str().unwrap())
        .collect();
    assert_eq!(alpha_units, vec!["Alpha Unit", "Zeta Unit"]);
    let alpha_positions: Vec<&str> = chart["companies"][0]["units"][0]["positions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["title"].as_str().unwrap())
        .collect();
    assert_eq!(alpha_positions, vec!["Associate", "Manager"]);

    // Tied (company, name, source_sheet, source_row) employees must match e.id ASC even after heap-moving UPDATEs.
    let mut tie_ids = Vec::new();
    for i in 0..4 {
        let id = seed_employee(
            &pool,
            org,
            branch,
            unit_alpha,
            "Same Tie",
            &format!("TIE-{i}"),
            1,
        )
        .await;
        tie_ids.push(id);
    }
    tie_ids.sort();
    // Move the lowest-UUID row's heap tuple via an UPDATE.
    sqlx::query("UPDATE employees SET worksite_name = 'Moved Plant' WHERE id = $1")
        .bind(tie_ids[0])
        .execute(&pool)
        .await
        .unwrap();

    let (status, list) = ops
        .call(
            "GET",
            &format!("/api/v1/employees?org_unit_id={unit_alpha}&search=Same%20Tie&limit=50"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let list_ids: Vec<Uuid> = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| Uuid::parse_str(item["id"].as_str().unwrap()).unwrap())
        .collect();
    assert_eq!(list_ids, tie_ids);

    // Full unit order from /employees must match /unit-position prev_id/next_id chain.
    let (status, full_list) = ops
        .call(
            "GET",
            &format!("/api/v1/employees?org_unit_id={unit_alpha}&limit=50"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{full_list}");
    let full_ids: Vec<&str> = full_list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    let tie_pos = full_ids
        .iter()
        .position(|id| *id == tie_ids[1].to_string())
        .unwrap();
    let (status, pos) = ops
        .call(
            "GET",
            &format!("/api/v1/employees/{}/unit-position", tie_ids[1]),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pos}");
    assert_eq!(pos["index"], json!(tie_pos + 1));
    assert_eq!(pos["prev_id"], json!(full_ids[tie_pos - 1]));
    assert_eq!(pos["next_id"], json!(full_ids[tie_pos + 1]));
}
