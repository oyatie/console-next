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
