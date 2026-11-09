// SPDX-License-Identifier: LicenseRef-Proprietary
//! Attendance preserves workplace admission and rejects filters beyond it.
use super::{FORBIDDEN, support, world};
use http::StatusCode;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn day_board_refuses_filters_outside_a_workplace_grant(pool: PgPool) {
    let mut w = world(pool).await;
    let reader = w.holder("WORKPLACE", Some(&w.wp_a.clone())).await;
    let workplace_b: String =
        sqlx::query_scalar("SELECT id::text FROM workplaces WHERE legal_entity_id=$1::uuid")
            .bind(&w.le_b)
            .fetch_one(&w.pool)
            .await
            .unwrap();
    for (filter, inside, outside) in [
        ("workplace_id", &w.wp_a, &workplace_b),
        ("unit_id", &w.dept_x, &w.dept_b),
    ] {
        for (node, expected) in [(inside, StatusCode::OK), (outside, FORBIDDEN)] {
            let (status, body) = reader
                .call(
                    "GET",
                    &format!(
                        "/api/v1/attendance/days?date={}&{filter}={node}",
                        support::today_kst()
                    ),
                    None,
                )
                .await;
            assert_eq!(status, expected, "{filter}: {body}");
            if expected == FORBIDDEN {
                assert_eq!(body["error"]["code"], "forbidden");
                assert!(body.get("ledger").is_none());
                assert!(body.get("issue_groups").is_none());
            }
        }
    }
    // A department grant elsewhere cannot add rows or filter reach to the workplace grant.
    let department_reader = w.holder("DEPARTMENT", Some(&w.dept_b.clone())).await;
    let mut tx = w.pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE access_grants SET account_id=$1 WHERE org_id=$2 AND account_id=$3")
        .bind(reader.user.as_uuid())
        .bind(w.org)
        .bind(department_reader.user.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (status, board) = reader
        .call(
            "GET",
            &format!("/api/v1/attendance/days?date={}", support::today_kst()),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{board}");
    assert_eq!(board["ledger"]["people"], 1);
    let (status, body) = reader
        .call(
            "GET",
            &format!(
                "/api/v1/attendance/days?date={}&unit_id={}",
                support::today_kst(),
                w.dept_b
            ),
            None,
        )
        .await;
    assert_eq!(status, FORBIDDEN, "{body}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn weekly_totals_follow_the_cedar_workplace_read_set(pool: PgPool) {
    let mut w = world(pool).await;
    let reader = w.holder("WORKPLACE", Some(&w.wp_a.clone())).await;
    let today = time::Date::parse(
        &support::today_kst(),
        time::macros::format_description!("[year]-[month]-[day]"),
    )
    .unwrap();
    let monday = today - time::Duration::days(i64::from(today.weekday().number_days_from_monday()));
    let path = format!("/api/v1/attendance/week52?week_start={monday}");
    let (status, body) = reader.call("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows = body["items"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{body}");
    assert_eq!(rows[0]["employee_id"], w.a1);
    assert_eq!(
        rows[0].get("recognized_hours"),
        Some(&serde_json::Value::Null)
    );
    assert_eq!(
        rows[0].get("overtime_hours"),
        Some(&serde_json::Value::Null)
    );
    let (status, body) = reader
        .call("GET", &format!("{path}&branch_id={}", w.branch_b), None)
        .await;
    assert_eq!(status, FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn weekly_branch_without_workplaces_requires_tenant_read(pool: PgPool) {
    let mut w = world(pool).await;
    let reader = w.holder("WORKPLACE", Some(&w.wp_a.clone())).await;
    let branch: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO branches (org_id,region_id,name) SELECT org_id,region_id,'미배치 지점' FROM branches WHERE id=$1::uuid RETURNING id",
    ).bind(&w.branch_a).fetch_one(&w.pool).await.unwrap();
    let path = format!("/api/v1/attendance/week52?week_start=2026-10-26&branch_id={branch}");
    let (status, body) = reader.call("GET", &path, None).await;
    assert_eq!(status, FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");
    assert!(body.get("items").is_none());
    let (status, body) = w.ops.call("GET", &path, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"], serde_json::json!([]));
}
