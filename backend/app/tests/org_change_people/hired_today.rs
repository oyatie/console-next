//! UX-R3 STRUCT org-01 (P0): moving a 부서 to another 사업장 on the day one of
//! its people was placed. The preflight runs what submit runs, so it names the
//! cause and the fix (시행일 the next day); submit refuses with the same code,
//! moves nobody and records nothing; the fixed date then goes through.

use http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::fixture::{CHANGES, Tenant, day, seed, tenant};

/// A person in `unit`, hired and placed at `workplace` today.
async fn hired_today(t: &Tenant, unit: Uuid, workplace: Uuid) -> Uuid {
    let (org, entity, actor, id, on) = (t.org, t.entity, t.actor, Uuid::new_v4(), day(0));
    let sql = format!(
        "INSERT INTO employees (id, org_id, company, name, position, source_filename, source_sheet, source_row, \
         source_key, hire_date, org_unit_id, employment_status) VALUES ('{id}', '{org}', 'Co', '오늘입사', '사원', \
         'console', 'console', 1, '{id}', '{on}', '{unit}', 'ACTIVE'); \
         INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, \
         actor_id, command_id) VALUES ('{org}', '{id}', '{entity}', '{workplace}', '{on}', 'HIRE', '{actor}', gen_random_uuid());"
    );
    seed(&t.owner, org, sql).await;
    id
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_move_on_a_placement_day_is_named_before_submit_and_refused_by_it(
    pool: PgPool,
) {
    // regression: r3 org-01 (P0) — 「사전 점검 통과」, then submit 409 {code: conflict} and an orphan draft.
    let t = tenant(pool).await;
    let [_, pangyo] = t.workplaces;
    let support = t.dept("경영지원본부", t.sites[0]).await;
    let dev = t.dept("개발팀", t.sites[1]).await;
    let new = hired_today(&t, dev, pangyo).await;
    let ops = json!([{"op": "MOVE_ORG_UNIT", "orgUnitId": dev, "parentId": support}]);
    let id = t.draft("REORG", dev, ops, &day(0)).await;

    // The preflight names the cause and its fix.
    let (status, checked) = t
        .ops
        .send("POST", &format!("{CHANGES}/{id}/preflight"), None, false)
        .await;
    assert_eq!(status, StatusCode::OK, "{checked}");
    let blockers = checked["preflight"]["blockers"].as_array().unwrap();
    assert_eq!(blockers.len(), 1, "{checked}");
    assert_eq!(blockers[0]["code"], json!("assignment_starts_on_move_date"));
    assert!(
        blockers[0]["label"].as_str().unwrap().contains(&day(1)),
        "the fix names the next day: {checked}"
    );

    // Submit refuses with the same code; nothing moved, nothing applied, no submit audit.
    let (status, refused) = t
        .ops
        .send("POST", &format!("{CHANGES}/{id}/submit"), None, false)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], json!("preflight_blocked"));
    assert_eq!(
        refused["error"]["reasons"],
        json!(["assignment_starts_on_move_date"])
    );
    assert_eq!(
        t.live(new).await.len(),
        1,
        "the person stays where they were placed"
    );
    assert!(t.events(new).await.is_empty());
    assert_eq!(t.request(&id).await["status"], json!("DRAFT"));
    assert_eq!(t.audits("org_change.submit").await, 0);
    assert_eq!(
        t.head(dev).await.1["parent_id"],
        json!(t.sites[1].to_string()),
        "the 부서 did not move"
    );

    // The fix: 시행일 the next day. It is recorded for that date (policy none).
    let (status, body) = t
        .ops
        .send(
            "PATCH",
            &format!("{CHANGES}/{id}"),
            Some(json!({"effectiveDate": day(1), "reason": "조직 개편"})),
            false,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, sent) = t
        .ops
        .send("POST", &format!("{CHANGES}/{id}/submit"), None, false)
        .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["status"], json!("APPROVED"));
}
