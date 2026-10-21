//! #28: a 사업장 of 2,000 people closes in one plan. The request answers well
//! inside the 30 s request timeout (it checks the plan and schedules it); the
//! tick applies it all-or-none in one transaction with no request deadline.
//! Both times are printed for the READY note (measured, not hoped).

use std::time::Instant;

use serde_json::json;
use sqlx::PgPool;

use crate::close_support::ORG;
use crate::common;
use crate::fixture::*;

const PEOPLE: i64 = 2_000;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_people_close_by_one_plan_the_tick_applies(owner: PgPool) {
    let s = Site::new(&owner).await;
    // 2,000 more in 개발팀, placed at 부산지점 from 2026-01-02 (as the owner, in one statement each).
    sqlx::query(
        "WITH e AS (INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, org_unit_id) \
           SELECT $1, '주식회사 가나', '직원' || g, 'x', 'x', g, 'burst-' || g, $2 FROM generate_series(1, $3) g RETURNING id) \
         INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, cause, actor_id, command_id) \
         SELECT $1, e.id, $4, $5, DATE '2026-01-02', 'CORRECTION', $6, gen_random_uuid() FROM e",
    )
    .bind(ORG)
    .bind(s.dev)
    .bind(PEOPLE)
    .bind(s.w.entity)
    .bind(s.w.branch)
    .bind(*s.w.actor.user.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    let view =
        s.hr.workplace_close_plan(s.planner(uuid::Uuid::new_v4()).org, s.w.branch)
            .await
            .unwrap();
    assert_eq!(view.people.len() as i64, PEOPLE + 4);
    let people: Vec<_> = view
        .people
        .iter()
        .map(|p| {
            let to = match p.org_unit_id {
                Some(u) if u == s.dev || u == s.qa => u,
                _ => s.hr_team,
            };
            json!({ "employee_id": p.employee_id, "action": "TRANSFER", "to_org_unit_id": to })
        })
        .collect();
    let plan = json!({
        "closed_on": today().to_string(),
        "units": [
            { "org_unit_id": s.dev, "action": "MOVE", "to_parent_id": s.hq_unit },
            { "org_unit_id": s.logistics, "action": "DISSOLVE" },
        ],
        "people": people,
    });
    let started = Instant::now();
    let job = s.plan(plan).await.unwrap();
    let request = started.elapsed();
    assert_eq!(
        job.state, "SCHEDULED",
        "a plan this size is applied by the tick"
    );
    assert!(
        request.as_secs() < 30,
        "the planning request took {request:?}"
    );
    let started = Instant::now();
    assert_eq!(s.tick(today()).await, 1);
    let tick = started.elapsed();
    println!(
        "close of {} people: request {request:?}, tick apply {tick:?}",
        PEOPLE + 4
    );
    assert_eq!(state(&owner, job.id).await, "APPLIED");
    assert_eq!(common::placed_at(&owner, s.kim).await, s.w.hq);
    let moved: i64 = scalar(&owner, "SELECT count(*) FROM employment_assignments WHERE workplace_id = $1 AND superseded_at IS NULL AND valid_to IS NULL", s.w.hq).await;
    assert_eq!(moved, PEOPLE + 4);
}
