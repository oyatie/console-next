// SPDX-License-Identifier: LicenseRef-Proprietary
#![cfg(feature = "attendance")]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! Attendance record reads commit one batched 접속기록 before returning personal data.

#[path = "support/http.rs"]
mod support;
#[path = "access_log_reads/support.rs"]
mod transport;

#[path = "attendance_access_log/org.rs"]
mod org;

use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use support::{Ctx, ctx, employee_body, structure, tenant};
use time::OffsetDateTime;
use uuid::Uuid;

async fn world(pool: &PgPool) -> (Ctx, Vec<String>) {
    let (org, owner) = tenant(pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(pool, org, owner, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, branch, unit) = structure(&admin).await;
    let mut people = Vec::new();
    for number in ["ACCESS-1", "ACCESS-2"] {
        let mut body = employee_body(number, &branch, &unit);
        body["hire_date"] = json!("2026-01-02");
        let (status, hired) = admin.call("POST", "/api/v1/employees", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{hired}");
        let id = hired["employee"]["id"].as_str().unwrap().to_owned();
        let (status, bound) = admin
            .call(
                "POST",
                "/api/v1/employment-assignments",
                Some(json!({
                    "employee_id": id, "legal_entity_id": entity,
                    "workplace_id": workplace, "valid_from": "2026-01-02"
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{bound}");
        people.push(id);
    }
    (admin, people)
}

async fn read(admin: &Ctx, path: &str, token: &str) -> (StatusCode, Value) {
    transport::send(
        &admin.service,
        transport::get(
            path.to_owned(),
            token,
            transport::DIRECT_PEER,
            "198.51.100.99",
        ),
    )
    .await
}

async fn access_count(pool: &PgPool, org: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action LIKE 'attendance.%_read'",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_reads_record_exactly_the_returned_subjects_with_transport_and_task(
    pool: PgPool,
) {
    let (admin, people) = world(&pool).await;
    for (path, action, target) in [
        (
            "/api/v1/attendance/days?date=2026-10-06&rows=all".to_owned(),
            "attendance.day_read",
            "query".to_owned(),
        ),
        (
            "/api/v1/attendance/month?month=2026-10&limit=1".to_owned(),
            "attendance.month_read",
            "query".to_owned(),
        ),
        (
            format!(
                "/api/v1/attendance/people/{}/month?month=2026-10",
                people[0]
            ),
            "attendance.person_month_read",
            people[0].clone(),
        ),
        (
            "/api/v1/attendance/days?date=2026-10-06&issues_only=true".to_owned(),
            "attendance.day_read",
            "query".to_owned(),
        ),
    ] {
        let before = access_count(&pool, admin.org).await;
        let started = OffsetDateTime::now_utc();
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        let mut subjects: Vec<Value> = match action {
            "attendance.day_read" => body["groups"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|group| group["rows"].as_array().unwrap())
                .map(|row| row["employee_id"].clone())
                .collect(),
            "attendance.month_read" => body["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["employee_id"].clone())
                .collect(),
            _ => vec![body["employee_id"].clone()],
        };
        subjects.sort_by_key(Value::to_string);
        assert_eq!(access_count(&pool, admin.org).await, before + 1, "{path}");
        let row = sqlx::query("SELECT actor, occurred_at, ip, target_id, after_snap FROM audit_events WHERE org_id=$1 AND action=$2 ORDER BY occurred_at DESC LIMIT 1")
            .bind(admin.org).bind(action).fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<Uuid, _>("actor"), *admin.user.as_uuid());
        assert!(row.get::<OffsetDateTime, _>("occurred_at") >= started);
        assert_eq!(row.get::<String, _>("ip"), "203.0.113.7");
        assert_eq!(row.get::<String, _>("target_id"), target);
        let after: Value = row.get("after_snap");
        let mut logged = after["subject_ids"].as_array().unwrap().clone();
        logged.sort_by_key(Value::to_string);
        assert_eq!(logged, subjects);
        assert_eq!(after["subject_count"], subjects.len());
        assert_eq!(after["principal_type"], "TENANT_USER");
        assert!(after["session_id"].as_str().is_some());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn attendance_reads_release_no_personal_data_when_access_record_fails(pool: PgPool) {
    let (admin, people) = world(&pool).await;
    sqlx::query("REVOKE INSERT ON audit_events FROM console_rt")
        .execute(&pool)
        .await
        .unwrap();
    for path in [
        "/api/v1/attendance/days?date=2026-10-06".to_owned(),
        "/api/v1/attendance/month?month=2026-10".to_owned(),
        format!(
            "/api/v1/attendance/people/{}/month?month=2026-10",
            people[0]
        ),
    ] {
        let (status, body) = read(&admin, &path, &admin.token).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}: {body}");
        assert_eq!(body["error"]["code"], "unavailable");
        assert!(
            body.get("rows").is_none()
                && body.get("groups").is_none()
                && body.get("days").is_none()
        );
    }
    assert_eq!(access_count(&pool, admin.org).await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unresolved_actor_is_refused_and_authenticated_failed_reads_keep_refusal_audit(
    pool: PgPool,
) {
    let (org, owner) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(&pool, org, owner, &["SUPER_ADMIN"], None).await;
    for path in [
        "/api/v1/attendance/days?date=2026-10-06".to_owned(),
        "/api/v1/attendance/month?month=2026-10".to_owned(),
        format!(
            "/api/v1/attendance/people/{}/month?month=2026-10",
            Uuid::new_v4()
        ),
    ] {
        let (status, body) = read(&admin, &path, "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
    assert_eq!(access_count(&pool, org).await, 0);
    let (status, body) = read(
        &admin,
        &format!(
            "/api/v1/attendance/people/{}/month?month=2026-10",
            Uuid::new_v4()
        ),
        &admin.token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let denied: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND actor=$2 AND action='command.refused' AND outcome='DENIED' AND after_snap->>'refusal_code'='scope_not_found'")
        .bind(org).bind(owner.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(denied, 1);
    assert_eq!(access_count(&pool, org).await, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn view_as_access_events_keep_the_operator_tag_and_tenant_subjects(pool: PgPool) {
    use console_kernel_core::{BranchScope, OrgId};
    use console_platform_authz::Principal;
    use console_platform_authz::cedar_pbac::visible::load_support_session;
    use console_platform_request_context::audit_context::access_log::{
        AccessRecord, record_access,
    };

    let (org, subject) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let operator = support::add_user(&pool, *OrgId::platform().as_uuid(), &["SUPER_ADMIN"]).await;
    let mut principal = Principal::new(
        operator,
        OrgId::from_uuid(org),
        Default::default(),
        BranchScope::none(),
    );
    let session = Uuid::new_v4();
    sqlx::query("INSERT INTO support_sessions(org_id,id,operator_ref,operator_label,ticket_ref,reason_code,reason,scope,requested_duration_seconds,approved_duration_seconds,state,request_expires_at,request_assertion,operator_approver_ref,operator_approved_at,approval_assertion,tenant_approver_ref,tenant_approved_at,started_at,expires_at) VALUES($1,$2,$3,'지원 담당자','ACCESS-TEST','DIAGNOSE','접속기록 확인',ARRAY['hr_basic'],300,300,'ACTIVE',now()+interval '5 minutes',gen_random_uuid(),gen_random_uuid(),now(),gen_random_uuid(),$4,now(),now(),now()+interval '5 minutes')")
        .bind(org).bind(session).bind(operator.as_uuid()).bind(subject.as_uuid()).execute(&pool).await.unwrap();
    let runtime = transport::runtime_pool(&pool).await;
    let mut tx = runtime.begin().await.unwrap();
    principal.support = Some(
        load_support_session(&mut tx, principal.org_id, session)
            .await
            .unwrap(),
    );
    tx.commit().await.unwrap();
    record_access(
        &transport::runtime_pool(&pool).await,
        &principal,
        AccessRecord {
            action: "account.read",
            target_type: "user",
            target_id: subject.to_string(),
            subject_ids: &[*subject.as_uuid()],
            reader_subject: None,
            details: json!({}),
        },
    )
    .await
    .unwrap();
    let rows = sqlx::query(
        "SELECT actor, after_snap FROM audit_events WHERE org_id=$1 AND action='account.read'",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<Uuid, _>("actor"), *operator.as_uuid());
    let after: Value = rows[0].get("after_snap");
    assert_eq!(after["principal_type"], "SUPPORT_OPERATOR");
    assert_eq!(after["subject_ids"], json!([subject]));
    assert_eq!(after["self_read"], false);
}

#[path = "attendance_access_log/remaining.rs"]
mod remaining;
#[path = "attendance_access_log/view_as.rs"]
mod view_as;

#[path = "attendance_access_log/scopes.rs"]
mod scopes;
#[path = "attendance_access_log/subjects.rs"]
mod subjects;
