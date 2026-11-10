//! #28: a 사업장 of 2,000 people closes in one plan. The request answers well
//! inside the 30 s request timeout (it checks the plan and schedules it); the
//! tick applies it all-or-none in one transaction with no request deadline.
//! Both times are printed for the READY note (measured, not hoped).

use std::time::Instant;

use serde_json::json;
use sqlx::PgPool;
use tracing::instrument::WithSubscriber;

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
    let queries = crate::trail_queries::Queries::default();
    assert_eq!(s.tick(today()).with_subscriber(queries.clone()).await, 1);
    let statements = queries.statements();
    eprintln!("close tick statements: {}", statements.len());
    assert_eq!(
        statements
            .iter()
            .filter(|sql| sql.contains("SELECT filing_rule,trigger_event_kinds"))
            .count(),
        1
    );
    assert_eq!(
        statements
            .iter()
            .filter(|sql| sql.contains("INSERT INTO lifecycle_cases (org_id,id,kind,variant"))
            .count(),
        1
    );
    assert_eq!(
        statements
            .iter()
            .filter(
                |sql| sql.contains("SELECT i.id,c.id AS case_id,i.kind,i.requested_on,i.due_basis")
            )
            .count(),
        1
    );
    let tick = started.elapsed();
    println!(
        "close of {} people: request {request:?}, tick apply {tick:?}",
        PEOPLE + 4
    );
    assert_eq!(state(&owner, job.id).await, "APPLIED");
    assert_eq!(common::placed_at(&owner, s.kim).await, s.w.hq);
    let moved: i64 = scalar(&owner, "SELECT count(*) FROM employment_assignments WHERE workplace_id = $1 AND superseded_at IS NULL AND valid_to IS NULL", s.w.hq).await;
    assert_eq!(moved, PEOPLE + 4);
    explain_holds(&owner, job.id, &statements).await;
}

async fn explain_holds(owner: &PgPool, job: uuid::Uuid, statements: &[String]) {
    let logged = statements
        .iter()
        .find(|sql| sql.contains("UPDATE lifecycle_case_items i SET blocks_close="))
        .unwrap();
    let sql: String = serde_json::from_str(
        logged
            .split("db.statement=")
            .nth(1)
            .unwrap()
            .split(" rows_affected=")
            .next()
            .unwrap(),
    )
    .unwrap();
    let mut tx = owner.begin().await.unwrap();
    let cases: Vec<uuid::Uuid> = sqlx::query_scalar("SELECT c.id FROM lifecycle_cases c JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=c.trigger_id WHERE l.batch_id=$1")
        .bind(job).fetch_all(tx.as_mut()).await.unwrap();
    let holds: serde_json::Value = sqlx::query_scalar("SELECT jsonb_agg(jsonb_build_object('id',i.id,'case_id',c.id,'held',s.recording_held)) \
        FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id \
        JOIN case_template_items t ON t.template_key=c.template_key AND t.version=c.template_version AND t.item_key=i.item_key \
        JOIN lifecycle_filing_rules s ON s.code=t.due_register_code AND s.effective_from<=c.effective_date \
          AND (s.effective_to_exclusive IS NULL OR c.effective_date<s.effective_to_exclusive) \
        WHERE c.org_id=$1 AND c.id=ANY($2) AND s.recording_held IS NOT NULL")
        .bind(ORG).bind(&cases).fetch_one(tx.as_mut()).await.unwrap();
    sqlx::query("SET LOCAL ROLE console_rt")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(ORG.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let plan: serde_json::Value = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}"
    )))
    .bind(ORG)
    .bind(&cases)
    .bind(holds)
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    eprintln!(
        "case hold EXPLAIN (ANALYZE, BUFFERS): {}",
        serde_json::to_string_pretty(&plan).unwrap()
    );
    fn check(node: &serde_json::Value, scans: &mut usize) {
        if node["Function Name"] == "jsonb_to_recordset" {
            *scans += 1;
            assert_eq!(node["Actual Loops"], 1, "read the batch JSON once");
        }
        for child in node["Plans"].as_array().into_iter().flatten() {
            check(child, scans);
        }
    }
    let mut scans = 0;
    check(&plan[0]["Plan"], &mut scans);
    assert_eq!(scans, 1);
    tx.rollback().await.unwrap();
}
