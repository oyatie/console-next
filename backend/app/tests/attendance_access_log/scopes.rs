// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

pub(super) async fn cases(pool: &PgPool) -> (Ctx, Vec<(String, &'static str, Vec<String>)>) {
    let (admin, people) = world(pool).await;
    let unit: Uuid = sqlx::query_scalar("SELECT org_unit_id FROM employees WHERE id=$1")
        .bind(Uuid::parse_str(&people[0]).unwrap())
        .fetch_one(pool)
        .await
        .unwrap();
    let branch: Uuid = sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id=$1")
        .bind(Uuid::parse_str(&people[0]).unwrap())
        .fetch_one(pool)
        .await
        .unwrap();
    let canceller = support::add_user(pool, admin.org, &["SUPER_ADMIN"]).await;
    let (status, pattern) = admin.call("POST", "/api/v1/attendance/patterns", Some(json!({
        "name":"접속기록 근무", "kind":"WEEKLY", "days":[
            {"kind":"WORK", "shift":{"start":540,"end":1080,"breaks":[{"start":720,"end":780}]}},
            {"kind":"REST_DAY"},{"kind":"REST_DAY"},{"kind":"REST_DAY"},
            {"kind":"REST_DAY"},{"kind":"REST_DAY"},{"kind":"WEEKLY_HOLIDAY"}
        ]
    }))).await;
    assert_eq!(status, StatusCode::CREATED, "{pattern}");
    for day in ["2099-01-01", "2099-02-01"] {
        let (status, layers) = admin
            .call(
                "POST",
                "/api/v1/attendance/schedule/layers",
                Some(json!({
                    "targets":[
                        {"scope_kind":"PERSON","scope_id":people[0]},
                        {"scope_kind":"DEPARTMENT","scope_id":unit}
                    ],
                    "pattern_id":pattern["id"], "effective_from":day, "reason":"STANDARD"
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{layers}");
    }
    sqlx::query("UPDATE attendance_schedule_layers SET cancelled_by=$1,cancelled_at=now(),status='CANCELLED',cancel_reason='취소' WHERE org_id=$2 AND effective_from='2099-02-01'")
        .bind(canceller.as_uuid()).bind(admin.org).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO attendance_month_closes(org_id,month,checks,attested_by,branch_id) VALUES($1,'2026-10-01',$3,$2,$4)")
        .bind(admin.org).bind(admin.user.as_uuid()).bind(json!({"open_exceptions":0,"pending_leave":0,"already_closed":false})).bind(branch).execute(pool).await.unwrap();
    let close: Uuid = sqlx::query_scalar("SELECT id FROM attendance_month_closes WHERE org_id=$1")
        .bind(admin.org)
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO attendance_close_amendments(org_id,close_id,reason,detail,idempotency_key,request_fingerprint,actor_user_id) VALUES($1,$2,'정정','접속기록 확인',gen_random_uuid()::text,repeat('a',64),$3)")
        .bind(admin.org).bind(close).bind(canceller.as_uuid()).execute(pool).await.unwrap();
    (
        admin,
        vec![
            (
                format!(
                    "/api/v1/attendance/schedule/layers?scope_kind=PERSON&scope_id={}",
                    people[0]
                ),
                "attendance.layers_read",
                vec![people[0].clone()],
            ),
            (
                format!("/api/v1/attendance/schedule/layers?scope_kind=DEPARTMENT&scope_id={unit}"),
                "attendance.layers_read",
                vec![],
            ),
            (
                "/api/v1/attendance/schedule/tree?date=2026-10-06".into(),
                "attendance.schedule_tree_read",
                people.clone(),
            ),
            (
                format!("/api/v1/attendance/closes?month=2026-10&branch_id={branch}"),
                "attendance.closes_read",
                vec![],
            ),
            (
                format!("/api/v1/attendance/closes?month=2026-09&branch_id={branch}"),
                "attendance.closes_read",
                vec![],
            ),
            (
                format!("/api/v1/org-units/{unit}"),
                "org_unit.read",
                people.clone(),
            ),
            (
                format!("/api/v1/org-structure/units/{unit}/members"),
                "org_unit.members_read",
                people,
            ),
        ],
    )
}

pub(super) async fn count(pool: &PgPool, org: Uuid, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action=$2")
        .bind(org)
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap()
}

pub(super) async fn assert_event(
    pool: &PgPool,
    org: Uuid,
    action: &str,
    actor: Uuid,
    subjects: &[String],
    start: OffsetDateTime,
    kind: &str,
) {
    let row = sqlx::query("SELECT actor,occurred_at,ip,after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC LIMIT 1")
        .bind(org).bind(action).fetch_one(pool).await.unwrap();
    assert_eq!(row.get::<Uuid, _>("actor"), actor);
    assert!(row.get::<OffsetDateTime, _>("occurred_at") >= start);
    assert_eq!(row.get::<String, _>("ip"), "203.0.113.7");
    let after: Value = row.get("after_snap");
    let mut actual: Vec<String> = serde_json::from_value(after["subject_ids"].clone()).unwrap();
    let mut expected = subjects.to_vec();
    actual.sort();
    expected.sort();
    assert_eq!(actual, expected, "{action}");
    assert_eq!(after["subject_count"], expected.len());
    assert_eq!(after["principal_type"], kind);
    assert!(after["session_id"].as_str().is_some());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scope_reads_log_exact_returned_subjects_once(pool: PgPool) {
    let (admin, cases) = cases(&pool).await;
    let mut missing = vec![];
    for (path, action, subjects) in cases {
        let before = count(&pool, admin.org, action).await;
        let start = OffsetDateTime::now_utc();
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert!(
            body.to_string().find("access_subject").is_none(),
            "internal ids must stay off the wire"
        );
        if count(&pool, admin.org, action).await != before + 1 {
            missing.push(path);
            continue;
        }
        assert_event(
            &pool,
            admin.org,
            action,
            *admin.user.as_uuid(),
            &subjects,
            start,
            "TENANT_USER",
        )
        .await;
        let after: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC,id DESC LIMIT 1")
            .bind(admin.org).bind(action).fetch_one(&pool).await.unwrap();
        assert_eq!(after["self_read"], false, "unlinked reader: {path}");
        if matches!(
            action,
            "attendance.layers_read" | "attendance.closes_read" | "org_unit.read"
        ) {
            let users: Vec<Uuid> = if action == "attendance.layers_read" {
                sqlx::query_scalar("SELECT DISTINCT user_id FROM attendance_schedule_layers l CROSS JOIN LATERAL unnest(ARRAY[l.created_by,l.cancelled_by]) user_id WHERE l.org_id=$1 AND user_id IS NOT NULL ORDER BY user_id")
                    .bind(admin.org).fetch_all(&pool).await.unwrap()
            } else if action == "attendance.closes_read" {
                sqlx::query_scalar("SELECT DISTINCT user_id FROM attendance_month_closes c LEFT JOIN attendance_close_amendments a ON a.close_id=c.id AND a.org_id=c.org_id CROSS JOIN LATERAL unnest(ARRAY[c.attested_by,a.actor_user_id]) user_id WHERE c.org_id=$1 AND to_char(c.month,'YYYY-MM')=$2 AND user_id IS NOT NULL ORDER BY user_id")
                    .bind(admin.org).bind(if path.contains("2026-09") { "2026-09" } else { "2026-10" }).fetch_all(&pool).await.unwrap()
            } else {
                let unit = Uuid::parse_str(path.rsplit('/').next().unwrap()).unwrap();
                sqlx::query_scalar("SELECT DISTINCT actor_id FROM org_unit_revisions WHERE org_unit_id=$1 AND actor_id IS NOT NULL ORDER BY actor_id")
                    .bind(unit).fetch_all(&pool).await.unwrap()
            };
            if !path.contains("2026-09") {
                assert!(!users.is_empty(), "fixture needs user-only principals");
            }
            let mut recorded_users: Vec<Uuid> =
                serde_json::from_value(after["user_subject_ids"].clone()).unwrap();
            recorded_users.sort();
            assert_eq!(recorded_users, users, "{action}: user principals retained");
            assert!(after.get("employee_subject_ids").is_none());
            for user in users {
                assert!(
                    !subjects.contains(&user.to_string()),
                    "user ids cannot be person subjects"
                );
            }
        }
    }
    assert!(missing.is_empty(), "missing access events: {missing:?}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scope_reads_refuse_anonymous_and_withhold_data_if_logging_fails(pool: PgPool) {
    let (admin, cases) = cases(&pool).await;
    for (path, action, _) in &cases {
        let before = count(&pool, admin.org, action).await;
        let (status, body) = read(&admin, path, "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}: {body}");
        assert_eq!(count(&pool, admin.org, action).await, before);
    }
    sqlx::query("REVOKE INSERT ON audit_events FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    let mut leaked = vec![];
    for (path, _, _) in cases {
        let (status, body) = read(&admin, &path, &admin.token).await;
        if status != StatusCode::SERVICE_UNAVAILABLE {
            leaked.push((path, status));
            continue;
        }
        assert_eq!(body["error"]["code"], "unavailable");
        assert!(
            body.get("items").is_none()
                && body.get("members").is_none()
                && body.get("nodes").is_none()
        );
    }
    assert!(
        leaked.is_empty(),
        "data released without logging: {leaked:?}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_layer_scope_keeps_authenticated_refusal_attempt(pool: PgPool) {
    let (admin, _) = world(&pool).await;
    let before = access_count(&pool, admin.org).await;
    let (status, body) = read(
        &admin,
        &format!(
            "/api/v1/attendance/schedule/layers?scope_kind=PERSON&scope_id={}",
            Uuid::new_v4()
        ),
        &admin.token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(access_count(&pool, admin.org).await, before);
    let denied: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND actor=$2 AND action='command.refused' AND outcome='DENIED' AND after_snap->>'refusal_code'='scope_not_found'")
        .bind(admin.org).bind(admin.user.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(denied, 1);
}
