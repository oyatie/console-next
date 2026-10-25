// SPDX-License-Identifier: LicenseRef-Proprietary
//! Org depth: impact, scheduled facts, command selection and member titles.
use super::fixture::{CHANGES, day, seed, tenant, today};
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

async fn preflight(t: &super::fixture::Tenant, unit: Uuid, ops: Value) -> Value {
    let id = t.draft("REORG", unit, ops, &day(2)).await;
    let (status, body) = t
        .ops
        .call("POST", &format!("{CHANGES}/{id}/preflight"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn proposal_impact_counts_people_moving_instead_of_people_in_the_target(pool: PgPool) {
    let t = tenant(pool).await;
    let a = t.dept("A", t.sites[0]).await;
    let child = t.dept("Child", a).await;
    let b = t.dept("B", t.sites[0]).await;
    let one = t.person("One", a, t.workplaces[0], "ACTIVE").await;
    t.person("Leave", a, t.workplaces[0], "ON_LEAVE").await;
    t.person("Child", child, t.workplaces[0], "ACTIVE").await;
    for (ops, expected) in [
        (
            json!([{"op":"CREATE_ORG_UNIT","kind":"DEPARTMENT","parentId":a,"name":"Empty"}]),
            0,
        ),
        (
            json!([{"op":"RENAME_ORG_UNIT","orgUnitId":a,"name":"Renamed"}]),
            0,
        ),
        (
            json!([{"op":"MOVE_ORG_UNIT","orgUnitId":a,"parentId":b}]),
            0,
        ),
        (
            json!([{"op":"MOVE_ORG_UNIT","orgUnitId":a,"parentId":t.sites[1]}]),
            3,
        ),
        (
            json!([{"op":"REASSIGN_ORG_UNIT","fromOrgUnit":a,"toOrgUnit":b,"scope":{"company":"Co"},"employeeIds":[one]}]),
            1,
        ),
        (
            json!([{"op":"REASSIGN_ORG_UNIT","fromOrgUnit":a,"toOrgUnit":b,"scope":{"company":"Co"}},
            {"op":"MOVE_ORG_UNIT","orgUnitId":child,"parentId":b},
            {"op":"DISSOLVE_ORG_UNIT","orgUnitId":a,"mergedInto":b}]),
            2,
        ),
    ] {
        let body = preflight(&t, a, ops).await;
        assert_eq!(body["preflight"]["headcount"], expected, "{body}");
        assert_eq!(body["headcount"], expected, "one receipt field: {body}");
    }
    assert_eq!(
        t.unit_of(one).await,
        Some(a),
        "preflight rolls back every write"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_time_is_a_tenant_setting_shared_by_response_and_scheduler(pool: PgPool) {
    let t = tenant(pool).await;
    let a = t.dept("A", t.sites[0]).await;
    let (_, scheduled) = t
        .change(
            "REORG",
            a,
            json!([{"op":"RENAME_ORG_UNIT","orgUnitId":a,"name":"Later"}]),
            &day(2),
        )
        .await;
    let id = scheduled["id"].as_str().unwrap();
    let at = OffsetDateTime::parse(
        scheduled["applies_at"].as_str().unwrap_or("missing"),
        &time::format_description::well_known::Rfc3339,
    )
    .expect("server serves a scheduled UTC instant");
    let zone = UtcOffset::from_hms(9, 0, 0).unwrap();
    assert_eq!(at.to_offset(zone).date().to_string(), day(2));
    assert_eq!(at.to_offset(zone).time().as_hms(), (0, 5, 0));
    seed(&t.owner, t.org, format!("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code,effective_from) VALUES('{}','orgchange.apply_time','1439','{}','ORG',now()-interval '2 days')", t.org, t.actor)).await;
    let moved = t.request(id).await;
    let at = OffsetDateTime::parse(
        moved["applies_at"].as_str().unwrap(),
        &time::format_description::well_known::Rfc3339,
    )
    .unwrap();
    assert_eq!(at.to_offset(zone).time().as_hms(), (23, 59, 0));
    seed(
        &t.owner,
        t.org,
        format!(
            "UPDATE org_change_requests SET effective_date='{}' WHERE id='{id}'",
            today()
        ),
    )
    .await;
    let (status, listed) = t
        .ops
        .call("GET", &format!("{CHANGES}?target_ref={a}"), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(
        listed["items"][0]["applies_at"],
        t.request(id).await["applies_at"]
    );
    let noon = today().with_hms(12, 0, 0).unwrap().assume_offset(zone);
    assert_eq!(
        console_app::org_change_schedule::apply_due_org_changes_at(&t.owner, today(), noon).await,
        Ok(0)
    );
    seed(&t.owner, t.org, format!("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code,effective_from) VALUES('{}','orgchange.apply_time','0','{}','ORG',now()-interval '1 day')", t.org, t.actor)).await;
    let moved = t.request(id).await;
    assert!(
        moved["applies_at"]
            .as_str()
            .unwrap()
            .ends_with("T15:00:00Z")
    );
    assert_eq!(
        console_app::org_change_schedule::apply_due_org_changes_at(&t.owner, today(), noon).await,
        Ok(1)
    );
    assert_eq!(t.request(id).await["status"], "APPLIED");
    assert!(t.request(id).await.get("applies_at").is_none());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unit_timeline_filter_applies_before_pagination(pool: PgPool) {
    let t = tenant(pool).await;
    let a = t.dept("A", t.sites[0]).await;
    let b = t.dept("B", t.sites[0]).await;
    for unit in [a, b] {
        t.change(
            "REORG",
            unit,
            json!([{"op":"RENAME_ORG_UNIT","orgUnitId":unit,"name":"Later"}]),
            &day(2),
        )
        .await;
    }
    let (_, page) = t
        .ops
        .call(
            "GET",
            &format!("{CHANGES}?target_ref={a}&status=APPROVED&limit=1"),
            None,
        )
        .await;
    assert_eq!(
        page["total"], 1,
        "target filter applies before pagination: {page}"
    );
    assert_eq!(page["items"][0]["target"]["ref"], a.to_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn created_unit_selection_comes_from_the_canonical_command_result(pool: PgPool) {
    let t = tenant(pool).await;
    let a = t.dept("A", t.sites[0]).await;
    let (status, applied) = t
        .change(
            "NEW",
            a,
            json!([{"op":"CREATE_ORG_UNIT","kind":"DEPARTMENT","parentId":a,"name":"New unit"}]),
            &day(0),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    let created = applied["created_unit_ids"]
        .as_array()
        .expect("command result contains actual units");
    assert_eq!(created.len(), 1);
    let unit = Uuid::parse_str(created[0].as_str().unwrap()).unwrap();
    assert_eq!(t.head(unit).await.1["name"], "New unit");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn both_member_reads_resolve_the_employee_card_title_fact(pool: PgPool) {
    let t = tenant(pool).await;
    let a = t.dept("A", t.sites[0]).await;
    let person = t.person("One", a, t.workplaces[0], "ACTIVE").await;
    let title = Uuid::new_v4();
    seed(&t.owner, t.org, format!("INSERT INTO job_titles(org_id,id,label,kind,created_by) VALUES('{}','{title}','팀장','POSITION','{}'); UPDATE employees SET position_kind_id='{title}' WHERE id='{person}'", t.org, t.actor)).await;
    for (path, key) in [
        (format!("/api/v1/org-units/{a}"), "members"),
        (format!("/api/v1/org-structure/units/{a}/members"), ""),
    ] {
        let (status, body) = t.ops.call("GET", &path, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let members = if key.is_empty() { &body } else { &body[key] };
        assert_eq!(members["items"][0]["title"], "팀장", "{body}");
    }
}
