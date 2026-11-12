//! Fail-closed: every refusal names its lines (or the workplace's role) with its
//! code, and writes nothing — no job, no transfer, no exit case, no audit row.

use serde_json::json;
use sqlx::PgPool;

use crate::fixture::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_plan_missing_anyone_or_any_department_is_refused_naming_them(owner: PgPool) {
    let s = Site::new(&owner).await;
    let e = s
        .plan(json!({
            "closed_on": today().to_string(),
            "units": [{ "org_unit_id": s.dev, "action": "DISSOLVE" }],
            "people": [
                { "employee_id": s.kim, "action": "EXIT" },
                { "employee_id": s.lee, "action": "EXIT" },
                { "employee_id": s.park, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
            ],
        }))
        .await
        .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (422, "close_plan_incomplete"));
    let mut want = vec![
        (s.choi.to_string(), "line_missing".to_owned()),
        (s.logistics.to_string(), "line_missing".to_owned()),
    ];
    want.sort();
    assert_eq!(named(&e), want);
    assert_eq!(nothing_written(&owner).await, (0, 0, 0, 0));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lines_that_cannot_apply_are_refused_together_and_nothing_is_written(owner: PgPool) {
    let s = Site::new(&owner).await;
    let e = s
        .plan(json!({
            "closed_on": today().to_string(),
            "units": [
                { "org_unit_id": s.dev, "action": "MOVE", "to_parent_id": s.logistics },
                { "org_unit_id": s.logistics, "action": "DISSOLVE" },
            ],
            "people": [
                // A group transfer names where it goes: a typed refusal, never a silent transfer.
                { "employee_id": s.kim, "action": "GROUP_TRANSFER" },
                // A department of the closing workplace takes no one.
                { "employee_id": s.lee, "action": "TRANSFER", "to_org_unit_id": s.logistics },
                { "employee_id": s.park, "action": "EXIT", "exit_reason_code": "PERSONAL" },
                { "employee_id": s.choi, "action": "TRANSFER" },
            ],
        }))
        .await
        .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (422, "close_plan_refused"));
    let mut want = vec![
        (s.dev.to_string(), "workplace_not_open".to_owned()),
        (s.kim.to_string(), "to_org_unit_id_required".to_owned()),
        (s.lee.to_string(), "workplace_not_open".to_owned()),
        (s.park.to_string(), "exit_reason_not_for_close".to_owned()),
        (s.choi.to_string(), "to_org_unit_id_required".to_owned()),
    ];
    want.sort();
    assert_eq!(named(&e), want);
    // A refused target names where people could go instead (worst-case-10).
    let lee = e
        .refusals
        .as_ref()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["employee_id"] == json!(s.lee))
        .unwrap()
        .clone();
    assert_eq!(lee["open_workplace_ids"], json!([s.w.hq]));
    assert_eq!(nothing_written(&owner).await, (0, 0, 0, 0));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_head_office_a_past_date_and_a_second_plan_are_refused(owner: PgPool) {
    let s = Site::new(&owner).await;
    let empty = json!({ "closed_on": today().to_string() });
    // The head office is the representative workplace: it never closes alone.
    let body = serde_json::from_value(empty.clone()).unwrap();
    let e =
        s.hr.plan_workplace_close(
            s.planner(uuid::Uuid::new_v4()),
            s.w.hq,
            body,
            crate::common::port(),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (e.status.as_u16(), e.code),
        (409, "workplace_holds_entity_role")
    );
    // A closure date in the past is refused on its field.
    let yesterday = today().previous_day().unwrap().to_string();
    let e = s.plan(json!({ "closed_on": yesterday })).await.unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (422, "date_in_past"));
    assert_eq!(nothing_written(&owner).await, (0, 0, 0, 0));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn stray_duplicate_and_half_lines_are_refused(owner: PgPool) {
    let s = Site::new(&owner).await;
    let stranger = crate::close_support::employee(&owner, "stranger").await;
    let e = s
        .plan(json!({
            "closed_on": today().to_string(),
            "units": [
                { "org_unit_id": s.dev, "action": "MOVE" },
                { "org_unit_id": s.logistics, "action": "DISSOLVE" },
                { "org_unit_id": s.hr_team, "action": "DISSOLVE" },
            ],
            "people": [
                { "employee_id": s.kim, "action": "EXIT" },
                { "employee_id": s.kim, "action": "EXIT" },
                { "employee_id": s.lee, "action": "EXIT" },
                { "employee_id": s.park, "action": "EXIT" },
                { "employee_id": s.choi, "action": "EXIT" },
                { "employee_id": stranger, "action": "EXIT" },
            ],
        }))
        .await
        .unwrap_err();
    assert_eq!(
        (e.status.as_u16(), e.code),
        (422, "close_plan_refused"),
        "{}",
        e.message
    );
    let mut want = vec![
        (s.dev.to_string(), "to_parent_id_required".to_owned()),
        (s.hr_team.to_string(), "line_not_in_plan".to_owned()),
        (s.kim.to_string(), "line_duplicate".to_owned()),
        (stranger.to_string(), "line_not_in_plan".to_owned()),
    ];
    want.sort();
    assert_eq!(named(&e), want);
    let e = s
        .plan(json!({ "closed_on": "2026-13-45" }))
        .await
        .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (422, "invalid_date"));
    assert_eq!(nothing_written(&owner).await, (0, 0, 0, 0));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_bad_case_rule_retains_every_line_refusal_and_rolls_back(owner: PgPool) {
    use tracing::instrument::WithSubscriber;
    let s = Site::new(&owner).await;
    // Model an incompatible catalog rule without changing the production catalog or its constraints.
    sqlx::query("ALTER TABLE case_template_items DROP CONSTRAINT case_template_items_due_shape")
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query("UPDATE case_template_items SET due_anchor=NULL WHERE template_key='APPOINT' AND due_rule_kind<>'UNKNOWN' AND mode<>'REQUESTED'")
        .execute(&owner).await.unwrap();
    let queries = crate::trail_queries::Queries::default();
    let error = s
        .plan(json!({
            "closed_on": today().to_string(),
            "units": [
                { "org_unit_id": s.dev, "action": "MOVE", "to_parent_id": s.hq_unit },
                { "org_unit_id": s.logistics, "action": "DISSOLVE" },
            ],
            "people": [
                { "employee_id": s.kim, "action": "TRANSFER", "to_org_unit_id": s.dev },
                { "employee_id": s.lee, "action": "TRANSFER", "to_org_unit_id": s.qa },
                { "employee_id": s.park, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
                { "employee_id": s.choi, "action": "TRANSFER", "to_org_unit_id": s.hq_unit },
            ],
        }))
        .with_subscriber(queries.clone())
        .await
        .unwrap_err();
    assert_eq!(error.code, "close_plan_refused");
    let refused = error.refusals.as_ref().unwrap().as_array().unwrap();
    let actual: std::collections::BTreeSet<_> = refused
        .iter()
        .map(|r| r["employee_id"].as_str().unwrap().to_owned())
        .collect();
    let expected = [s.kim, s.lee, s.park, s.choi]
        .into_iter()
        .map(|id| id.to_string())
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(nothing_written(&owner).await, (0, 0, 0, 0));
    assert_eq!(
        queries
            .statements()
            .iter()
            .filter(|sql| sql.contains("SELECT filing_rule,trigger_event_kinds"))
            .count(),
        1
    );
}
