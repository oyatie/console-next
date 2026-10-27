// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

async fn reads(pool: &PgPool) -> (Ctx, Vec<(String, &'static str, Vec<String>, bool)>) {
    let (admin, people) = world(pool).await;
    let branch: Uuid = sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id=$1")
        .bind(Uuid::parse_str(&people[0]).unwrap())
        .fetch_one(pool)
        .await
        .unwrap();
    let workplace: Uuid = sqlx::query_scalar(
        "SELECT workplace_id FROM employment_assignments WHERE employee_id=$1 LIMIT 1",
    )
    .bind(Uuid::parse_str(&people[0]).unwrap())
    .fetch_one(pool)
    .await
    .unwrap();
    let mut exception = String::new();
    for day in ["2026-10-06", "2026-10-07"] {
        let (status, body) = admin
            .call(
                "POST",
                "/api/v1/attendance/exceptions",
                Some(json!({
                    "kind":"LATE", "employee_id":people[0], "branch_id":branch,
                    "work_date":day, "detail":"접속기록 확인"
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        exception = body["id"].as_str().unwrap().to_owned();
    }
    let (status, crew) = admin
        .call(
            "POST",
            "/api/v1/attendance/crews",
            Some(json!({
                "workplace_id": workplace, "name":"접속기록 근무조"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{crew}");
    let (status, body) = admin
        .call(
            "POST",
            &format!(
                "/api/v1/attendance/crews/{}/members",
                crew["id"].as_str().unwrap()
            ),
            Some(json!({
                "employee_ids":people, "valid_from":"2026-01-02"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    sqlx::query("UPDATE users SET employee_id=$1 WHERE id=$2")
        .bind(Uuid::parse_str(&people[0]).unwrap())
        .bind(admin.user.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    // Historical substitutions can repeat a subject across the covered/worker fields.
    sqlx::query("INSERT INTO attendance_substitutions(org_id,site,branch_id,role,cover_date,from_minutes,to_minutes,covered_employee_id,reason_kind,worker_employee_id,worker_name,worker_type,status,cancel_reason,idempotency_key,request_fingerprint,created_by) VALUES($1,'현장',$2,'근무','2026-10-06',480,960,$3,'OTHER',$4,'대체자','REGULAR','CANCELLED','취소',gen_random_uuid()::text,repeat('a',64),$5)")
        .bind(admin.org).bind(branch).bind(Uuid::parse_str(&people[0]).unwrap()).bind(Uuid::parse_str(&people[1]).unwrap()).bind(admin.user.as_uuid()).execute(pool).await.unwrap();
    let one = vec![people[0].clone()];
    let cases = vec![
        (
            "/api/v1/attendance/exceptions?month=2026-10".into(),
            "attendance.exceptions_read",
            one.clone(),
            false,
        ),
        (
            format!("/api/v1/attendance/exceptions/{exception}"),
            "attendance.exception_read",
            one.clone(),
            false,
        ),
        (
            "/api/v1/attendance/substitutions?month=2026-10".into(),
            "attendance.substitutions_read",
            people.clone(),
            false,
        ),
        (
            format!(
                "/api/v1/attendance/substitution-candidates?branch_id={branch}&covered_employee_id={}&cover_date=2026-10-06&from_minutes=480&to_minutes=960",
                people[0]
            ),
            "attendance.substitution_candidates_read",
            vec![people[1].clone()],
            false,
        ),
        (
            "/api/v1/attendance/week52?week_start=2026-10-05".into(),
            "attendance.week52_read",
            people,
            false,
        ),
        (
            "/api/v1/attendance/crews?date=2026-10-06".into(),
            "attendance.crews_read",
            body["members"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["employee_id"].as_str().unwrap().to_owned())
                .collect(),
            false,
        ),
        (
            format!(
                "/api/v1/attendance/schedule/calendar?scope_kind=PERSON&scope_id={}&month=2026-10",
                one[0]
            ),
            "attendance.schedule_read",
            one.clone(),
            false,
        ),
        (
            "/api/v1/attendance/me/schedule?month=2026-10".into(),
            "attendance.own_schedule_read",
            one.clone(),
            true,
        ),
        (
            "/api/v1/attendance/me/exceptions?month=2026-10".into(),
            "attendance.own_exceptions_read",
            one.clone(),
            true,
        ),
        (
            "/api/v1/attendance/me/week52?week_start=2026-10-05".into(),
            "attendance.own_week52_read",
            one,
            true,
        ),
    ];
    (admin, cases)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn remaining_reads_commit_one_subject_set_with_actor_transport_time_and_task(pool: PgPool) {
    let (admin, cases) = reads(&pool).await;
    let mut missing = Vec::new();
    for (path, action, mut subjects, own) in cases {
        let before = access_count(&pool, admin.org).await;
        let start = OffsetDateTime::now_utc();
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        if access_count(&pool, admin.org).await != before + 1 {
            missing.push(path);
            continue;
        }
        let row = sqlx::query("SELECT actor,occurred_at,ip,after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC LIMIT 1")
            .bind(admin.org).bind(action).fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<Uuid, _>("actor"), *admin.user.as_uuid());
        assert!(row.get::<OffsetDateTime, _>("occurred_at") >= start);
        assert_eq!(row.get::<String, _>("ip"), "203.0.113.7");
        let after: Value = row.get("after_snap");
        let mut actual: Vec<String> = serde_json::from_value(after["subject_ids"].clone()).unwrap();
        subjects.sort();
        actual.sort();
        assert_eq!(actual, subjects, "{path}");
        assert_eq!(after["subject_count"], subjects.len());
        assert_eq!(after["self_read"], own, "{path}");
        assert_eq!(after["principal_type"], "TENANT_USER");
        assert!(after["session_id"].as_str().is_some());
    }
    assert!(
        missing.is_empty(),
        "reads missing exactly one access event: {missing:?}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn remaining_reads_withhold_data_on_audit_failure_and_refuse_anonymous(pool: PgPool) {
    let (admin, cases) = reads(&pool).await;
    let before = access_count(&pool, admin.org).await;
    for (path, _, _, _) in &cases {
        let (status, body) = read(&admin, path, "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}: {body}");
    }
    assert_eq!(access_count(&pool, admin.org).await, before);
    sqlx::query("REVOKE INSERT ON audit_events FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    let mut leaked = Vec::new();
    for (path, _, _, _) in cases {
        let (status, body) = read(&admin, &path, &admin.token).await;
        if status != StatusCode::SERVICE_UNAVAILABLE {
            leaked.push((path, status));
            continue;
        }
        assert_eq!(body["error"]["code"], "unavailable");
        assert!(
            body.get("items").is_none()
                && body.get("days").is_none()
                && body.get("detail").is_none()
        );
    }
    assert_eq!(access_count(&pool, admin.org).await, before);
    assert!(
        leaked.is_empty(),
        "reads released data without an audit: {leaked:?}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn empty_self_reads_and_failed_authenticated_reads_do_not_invent_subjects(pool: PgPool) {
    let (admin, _) = reads(&pool).await;
    let stranger = support::add_user(&pool, admin.org, &["MEMBER"]).await;
    let unlinked = ctx(&pool, admin.org, stranger, &["MEMBER"], None).await;
    for path in [
        "/api/v1/attendance/me/exceptions?month=2025-01",
        "/api/v1/attendance/me/week52?week_start=2026-10-05",
    ] {
        let before = access_count(&pool, admin.org).await;
        let (status, body) = read(&unlinked, path, &unlinked.token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(access_count(&pool, admin.org).await, before + 1);
        let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action LIKE 'attendance.%_read' ORDER BY occurred_at DESC LIMIT 1")
            .bind(admin.org).fetch_one(&pool).await.unwrap();
        assert_eq!(after["subject_ids"], json!([]));
        assert_eq!(after["self_read"], false);
    }
    let before = access_count(&pool, admin.org).await;
    let (status, body) = read(
        &admin,
        &format!("/api/v1/attendance/exceptions/{}", Uuid::new_v4()),
        &admin.token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let denied: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND actor=$2 AND action='command.refused' AND outcome='DENIED' AND after_snap->>'refusal_code'='not_found'")
        .bind(admin.org).bind(admin.user.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(denied, 1);
    assert_eq!(access_count(&pool, admin.org).await, before);
}
