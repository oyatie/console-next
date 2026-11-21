// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::setup::{harness, seed_employee, seed_org, seed_unit_and_branch};

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
    let unit_alpha = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id, id) VALUES ($1, $2)")
        .bind(org)
        .bind(unit_alpha)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_unit_revisions \
         (org_id, org_unit_id, version, command_id, actor_id, payload_digest, attributes, receipt) \
         SELECT $1, $2, 1, gen_random_uuid(), u.id, decode(repeat('00', 32), 'hex'), \
                jsonb_build_object('name', 'Alpha Unit', 'kind', 'department', 'status', 'ACTIVE'), '{}'::jsonb \
         FROM users u WHERE u.org_id = $1 LIMIT 1",
    )
    .bind(org)
    .bind(unit_alpha)
    .execute(&pool)
    .await
    .unwrap();

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
