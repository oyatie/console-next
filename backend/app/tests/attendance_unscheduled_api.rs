// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
//! The assembled REST router forwards the no-schedule filter and preserves scope counts.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;

#[path = "support/http.rs"]
mod support;
use support::{ctx, employee_body, structure, tenant};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn day_board_rest_filters_a_mixed_group_only_when_requested(pool: PgPool) {
    let (org, owner) = tenant(&pool, &["SUPER_ADMIN"]).await;
    let admin = ctx(&pool, org, owner, &["SUPER_ADMIN"], None).await;
    let (entity, workplace, branch, unit) = structure(&admin).await;
    let mut people = Vec::new();
    for number in ["UNSCHEDULED", "SCHEDULED"] {
        let mut body = employee_body(number, &branch, &unit);
        body["hire_date"] = json!("2026-01-02");
        let (status, hired) = admin.call("POST", "/api/v1/employees", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{hired}");
        let person = hired["employee"]["id"].as_str().unwrap().to_owned();
        let (status, bound) = admin.call("POST", "/api/v1/employment-assignments", Some(json!({"employee_id": person, "legal_entity_id": entity, "workplace_id": workplace, "valid_from": "2026-01-02"}))).await;
        assert_eq!(status, StatusCode::CREATED, "{bound}");
        people.push(person);
    }
    let work = json!({"kind": "WORK", "shift": {"start": 540, "end": 1080, "breaks": [{"start": 720, "end": 780}]}});
    let (status, pattern) = admin.call("POST", "/api/v1/attendance/patterns", Some(json!({"name": "Office", "kind": "WEEKLY", "days": [work, work, work, work, work, {"kind": "REST_DAY"}, {"kind": "WEEKLY_HOLIDAY"}]}))).await;
    assert_eq!(status, StatusCode::CREATED, "{pattern}");
    let (status, assigned) = admin.call("POST", "/api/v1/attendance/schedule/layers", Some(json!({"targets": [{"scope_kind": "PERSON", "scope_id": people[1]}], "pattern_id": pattern["id"], "effective_from": "2026-01-02", "reason": "STANDARD"}))).await;
    assert!(status.is_success(), "{assigned}");

    for query in ["", "&no_schedule_only=false", "&no_schedule_only=true"] {
        let (status, board) = admin
            .call(
                "GET",
                &format!("/api/v1/attendance/days?date=2026-10-06{query}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{board}");
        assert_eq!(board["ledger"]["people"], 2);
        assert_eq!(board["ledger"]["no_schedule"], 1);
        let groups = board["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        let rows = groups[0]["rows"].as_array().unwrap();
        if query.ends_with("true") {
            assert_eq!(
                rows.len(),
                1,
                "REST no_schedule_only must exclude scheduled people"
            );
            assert_eq!(rows[0]["employee_id"], people[0]);
            assert_eq!(rows[0]["day"]["plan"]["kind"], "NO_SCHEDULE");
            assert_eq!(groups[0]["hidden"], 0);
        } else {
            assert_eq!(
                rows.len(),
                2,
                "omitted or false must retain both issue rows"
            );
        }
    }

    let (status, filtered) = admin
        .call(
            "GET",
            "/api/v1/attendance/days?date=2026-10-06&mark=NO_RECORD&limit=1",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{filtered}");
    assert_eq!(filtered["ledger"]["people"], 2);
    assert_eq!(
        filtered["issue_groups"],
        json!([
            {"kind": "NO_RECORD", "count": 1, "earliest_date": "2026-10-06"},
            {"kind": "NO_SCHEDULE", "count": 1, "earliest_date": "2026-10-06"}
        ])
    );
    assert_eq!(filtered["groups"][0]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["groups"][0]["rows"][0]["employee_id"], people[1]);
    let (status, empty) = admin
        .call(
            "GET",
            "/api/v1/attendance/days?date=2026-10-06&mark=MISSING_OUT",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(empty["groups"], json!([]));
    assert_eq!(empty["issue_groups"], filtered["issue_groups"]);
    let (status, invalid) = admin
        .call(
            "GET",
            "/api/v1/attendance/days?date=2026-10-06&mark=UNKNOWN",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid}");
    assert_eq!(invalid["error"]["code"], "invalid_query");

    let (status, saved) = admin
        .call(
            "POST",
            "/api/v1/attendance/entries",
            Some(json!({
                "cells": [{"employee_id": people[1], "work_date": "2026-10-06", "value": "="}],
                "source": "MANUAL", "evidence": {"kind": "PAPER_SHEET"}
            })),
        )
        .await;
    assert!(status.is_success(), "{saved}");
    for (query, expected_rows, expected_hidden) in [
        ("", 1, 1),
        ("&rows=all", 2, 0),
        ("&rows=all&no_schedule_only=true", 1, 0),
        ("&rows=all&issues_only=true", 1, 1),
    ] {
        let (status, board) = admin
            .call(
                "GET",
                &format!("/api/v1/attendance/days?date=2026-10-06{query}"),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{board}");
        assert_eq!(board["ledger"]["people"], 2);
        let group = &board["groups"][0];
        assert_eq!(group["rows"].as_array().unwrap().len(), expected_rows);
        assert_eq!(group["hidden"], expected_hidden);
    }
    let (status, _) = admin
        .call(
            "GET",
            "/api/v1/attendance/days?date=2026-10-06&rows=invalid",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // A department grant must not widen to everyone at its workplace.
    let reader =
        console_platform_test_support::seed_active_user(&pool, org, "MEMBER", "Scoped reader")
            .await;
    let role = uuid::Uuid::new_v4();
    let department = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
        .bind(org)
        .bind(department)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,1,$3,$4,decode(repeat('ab',32),'hex'),$5,'{}')")
        .bind(org).bind(department).bind(uuid::Uuid::new_v4()).bind(owner.as_uuid())
        .bind(json!({"kind":"department","name":"인사부","status":"active","parent_id":unit}))
        .execute(&pool).await.unwrap();
    sqlx::query("UPDATE employees SET org_unit_id=$2 WHERE id=$1")
        .bind(uuid::Uuid::parse_str(&people[1]).unwrap())
        .bind(department)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'조회','ACTIVE',1,$3)")
        .bind(org).bind(role).bind(owner.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'조회','ACTIVE','SETUP',$3)")
        .bind(org).bind(role).bind(owner.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view'])")
        .bind(org).bind(role).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,org_unit_id,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'DEPARTMENT',$4,now()-interval '1 day',true,'SETUP','TEST',$5)")
        .bind(org).bind(reader.as_uuid()).bind(role).bind(department).bind(owner.as_uuid()).execute(&pool).await.unwrap();
    let scoped = ctx(&pool, org, reader, &["MEMBER"], None).await;
    let (status, board) = scoped
        .call(
            "GET",
            "/api/v1/attendance/days?date=2026-10-06&mark=NO_SCHEDULE",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{board}");
    assert_eq!(board["ledger"]["people"], 1);
    assert_eq!(board["issue_groups"], json!([]));
    assert_eq!(board["groups"], json!([]));
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_at=now(),revoked_by=$2 WHERE org_id=$1 AND account_id=$2")
        .bind(org).bind(reader.as_uuid()).execute(&pool).await.unwrap();
    let (status, denied) = scoped
        .call("GET", "/api/v1/attendance/days?date=2026-10-06", None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    assert!(denied.get("issue_groups").is_none());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn day_board_refuses_ungranted_read_without_aggregate_disclosure(pool: PgPool) {
    let (org, user) = tenant(&pool, &["MEMBER"]).await;
    let member = ctx(&pool, org, user, &["MEMBER"], None).await;
    let (status, body) = member
        .call(
            "GET",
            "/api/v1/attendance/days?date=2026-10-06&mark=NO_RECORD",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");
    assert!(body.get("issue_groups").is_none());
    assert!(body.get("ledger").is_none());
}
