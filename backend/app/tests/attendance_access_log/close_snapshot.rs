// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn pending_leave(pool: &PgPool, admin: &Ctx, person: &str) {
    let requester = support::add_user(pool, admin.org, &["MEMBER"]).await;
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
        .bind(Uuid::parse_str(person).unwrap())
        .bind(requester.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let command = support::role_pool(pool, "console_leave_cmd", None).await;
    sqlx::query("SELECT * FROM leave_api.create_request($1,$2,$3,'annual',DATE '2026-10-06',DATE '2026-10-06',NULL,ARRAY['missing_calendar']::text[],NULL,NULL,NULL,NULL,NULL,$4,repeat('a',32),repeat('b',16))")
        .bind(admin.org).bind(Uuid::new_v4()).bind(requester.as_uuid())
        .bind(Uuid::new_v4()).execute(&command).await.unwrap();
}

async fn snapshot(pool: PgPool, workplace: bool, filtered: bool) {
    let (admin, people) = world(&pool).await;
    let branch: Uuid = sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id=$1")
        .bind(Uuid::parse_str(&people[0]).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    let scope = workplace.then_some(branch);
    let path = format!(
        "/api/v1/attendance/closes?month=2026-10{}",
        filtered
            .then_some(branch)
            .map(|id| format!("&branch_id={id}"))
            .unwrap_or_default()
    );
    pending_leave(&pool, &admin, &people[0]).await;
    let (status, receipt) = admin
        .call(
            "POST",
            "/api/v1/attendance/closes",
            Some(json!({
                "month": "2026-10", "branch_scope": scope, "attest": true
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{receipt}");
    let before = access_count(&pool, admin.org).await;
    let (status, board) = read(&admin, &path, &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{board}");
    let row = &board["items"][0];
    assert_eq!(
        row["branch_scope"],
        scope
            .map(|id| id.to_string())
            .unwrap_or_else(|| "org".into())
    );
    assert_eq!(row["closed"], true);
    assert_eq!(row["open_exceptions"], 0);
    assert_eq!(row["pending_leave"], 1);
    assert_eq!(row["close"], receipt);
    assert_eq!(access_count(&pool, admin.org).await, before + 1);

    // Simulate later source changes without rewriting the immutable close receipt.
    pending_leave(&pool, &admin, &people[1]).await;
    let (status, exception) = admin
        .call(
            "POST",
            "/api/v1/attendance/exceptions",
            Some(json!({
                "kind": "LATE", "employee_id": people[0], "branch_id": branch,
                "work_date": "2026-10-07", "detail": "마감 후 확인"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{exception}");
    let (status, live) = admin
        .call(
            "POST",
            "/api/v1/attendance/closes/preflight",
            Some(json!({
                "month": "2026-10", "branch_scope": scope, "attest": false
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{live}");
    for (key, count) in [("open_exceptions", "1"), ("pending_leave", "2")] {
        let check = live["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["key"] == key)
            .unwrap();
        assert_eq!(check["note"], count);
    }
    let (status, after) = read(&admin, &path, &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{after}");
    assert_eq!(
        after, board,
        "closed counts must come from the receipt, not live checks"
    );

    // A live-check source outage must not hide an already stored receipt.
    sqlx::query("REVOKE SELECT ON attendance_exceptions, leave_requests FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    let before = access_count(&pool, admin.org).await;
    let (status, after) = read(&admin, &path, &admin.token).await;
    assert_eq!(status, StatusCode::OK, "{after}");
    assert_eq!(after, board);
    assert_eq!(access_count(&pool, admin.org).await, before + 1);
    let (status, open) = read(&admin, &path.replace("2026-10", "2026-09"), &admin.token).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{open}");
    unavailable_envelope(&open);
    assert!(
        open.get("items").is_none(),
        "open counts must not be invented"
    );
    assert_eq!(access_count(&pool, admin.org).await, before + 1);

    sqlx::query("REVOKE INSERT ON audit_events FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    let (status, denied) = read(&admin, &path, &admin.token).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{denied}");
    assert!(denied.get("items").is_none());
    assert_eq!(access_count(&pool, admin.org).await, before + 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn organization_close_preserves_snapshot_without_live_sources(pool: PgPool) {
    snapshot(pool, false, false).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn workplace_close_preserves_snapshot_without_live_sources(pool: PgPool) {
    snapshot(pool, true, true).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn organization_close_preserves_snapshot_under_workplace_filter(pool: PgPool) {
    snapshot(pool, false, true).await;
}

fn unavailable_envelope(body: &Value) {
    assert_eq!(body["error"]["code"], "unavailable");
    for key in ["message", "trace_id", "support_ref", "support_ref_at"] {
        assert!(
            body["error"][key].as_str().is_some_and(|s| !s.is_empty()),
            "{key}: {body}"
        );
    }
    assert!(!body.to_string().contains("permission denied"));
    assert!(!body.to_string().contains("SELECT"));
}

async fn source_outage(pool: PgPool, source: &'static str) {
    let (admin, _) = world(&pool).await;
    sqlx::query(source).execute(&pool).await.unwrap();
    let before = access_count(&pool, admin.org).await;
    let (status, body) = read(
        &admin,
        "/api/v1/attendance/closes?month=2026-09",
        &admin.token,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    unavailable_envelope(&body);
    assert!(body.get("items").is_none());
    assert_eq!(access_count(&pool, admin.org).await, before);
    for path in [
        "/api/v1/attendance/closes/preflight",
        "/api/v1/attendance/closes",
    ] {
        let (status, body) = admin
            .call(
                "POST",
                path,
                Some(json!({"month": "2026-09", "attest": true})),
            )
            .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}: {body}");
        unavailable_envelope(&body);
    }
    let closes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attendance_month_closes WHERE org_id=$1")
            .bind(admin.org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(closes, 0, "source failures must not create a close");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn open_month_refuses_unavailable_exception_source(pool: PgPool) {
    source_outage(
        pool,
        "REVOKE SELECT ON attendance_exceptions FROM console_rt",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn open_month_refuses_unavailable_leave_source(pool: PgPool) {
    source_outage(pool, "REVOKE SELECT ON leave_requests FROM console_rt").await;
}
