#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R2 ENDS (company-01, worst-case-18, move-17): a 사업장 that still has
//! people and 부서 closes in one act, by a plan with a line for every person
//! and every 부서 under it — through `HrService`, as `console_rt`, with the
//! canonical OrgUnit owner behind the port. Every refusal names its lines and
//! writes nothing; the regression (`regression_`) cases fail on the parent,
//! where no close of a staffed 사업장 exists.

mod burst;
#[path = "../../../../entity/adapter-postgres/tests/close_support/mod.rs"]
mod close_support;
#[path = "../../../../entity/adapter-postgres/tests/common/mod.rs"]
mod common;
mod fixture;
mod group;
mod refusals;
mod scheduled;

use fixture::*;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_staffed_workplace_closes_today_by_one_plan(owner: PgPool) {
    let s = Site::new(&owner).await;
    let plan = json!({
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
    });
    let key = uuid::Uuid::new_v4();
    let job = s.plan_with(key, plan.clone()).await.unwrap();
    assert_eq!(job.state, "APPLIED", "{job:?}");

    // The 사업장 is closed today: closed_on, a CLOSED revision, its SITE unit gone.
    assert_eq!(
        close_support::closed_on(&owner, "workplaces", s.w.branch).await,
        Some(today())
    );
    assert_eq!(
        close_support::head(&owner, s.w.branch).await,
        ("CLOSED".into(), false)
    );
    // Everyone is at 본사, each by a dated 전근 recorded under the job.
    for e in [s.kim, s.lee, s.park, s.choi] {
        assert_eq!(common::placed_at(&owner, e).await, s.w.hq, "{e}");
    }
    let events: i64 = scalar(&owner, "SELECT count(*) FROM employee_lifecycle_events WHERE batch_id = $1 AND event_type = 'TRANSFER' AND state = 'APPLIED'", job.id).await;
    assert_eq!(events, 4);
    // 개발팀 (and 품질팀 with it) now sits under 본사; 물류팀 is 폐지.
    assert_eq!(
        common::unit_head(&owner, s.dev).await.2,
        Some(s.hq_unit.to_string())
    );
    assert_eq!(
        common::unit_head(&owner, s.qa).await.2,
        Some(s.dev.to_string())
    );
    assert_eq!(common::unit_head(&owner, s.logistics).await.1, "dissolved");
    assert_eq!(audits(&owner, "workplace.close_plan").await, 1);
    assert_eq!(audits(&owner, "workplace.close_job.apply").await, 1);

    // A replay of the same request answers the same job and writes nothing.
    let again = s.plan_with(key, plan).await.unwrap();
    assert_eq!((again.id, again.state.as_str()), (job.id, "APPLIED"));
    assert_eq!(audits(&owner, "workplace.close_plan").await, 1);

    // No one may be placed at the closed 사업장 afterwards (company-42's close half).
    let late = close_support::employee(&owner, "late").await;
    let err =
        s.w.store
            .bind_assignment(
                &common::cmd(&s.w.actor),
                close_support::bind(&s.w, late, s.w.branch, &today().to_string()),
            )
            .await
            .unwrap_err();
    assert_eq!(
        common::code(err).1,
        vec![("workplace_id".to_owned(), "workplace_closed")]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_close_with_exits_waits_for_them_and_the_tick_finishes_it(owner: PgPool) {
    let s = Site::new(&owner).await;
    let plan = json!({
        "closed_on": today().to_string(),
        "units": [
            { "org_unit_id": s.dev, "action": "DISSOLVE" },
            { "org_unit_id": s.logistics, "action": "DISSOLVE" },
        ],
        "people": [
            { "employee_id": s.kim, "action": "EXIT" },
            { "employee_id": s.lee, "action": "EXIT", "exit_reason_code": "INSOLVENCY" },
            { "employee_id": s.park, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
            { "employee_id": s.choi, "action": "TRANSFER", "to_org_unit_id": s.hq_unit },
        ],
    });
    let job = s.plan(plan).await.unwrap();
    assert_eq!(job.state, "WAITING");
    // The 퇴직 are reported (마지막 근무일 = yesterday, 폐업 · 도산), the 전근 done, the 사업장 still open.
    let cases: Vec<(String, String)> = sqlx::query_as(
        "SELECT exit_reason_code, effective_exit_date::TEXT FROM employee_exit_cases WHERE employee_id = ANY($1) ORDER BY exit_reason_code",
    )
    .bind(vec![s.kim, s.lee])
    .fetch_all(&owner)
    .await
    .unwrap();
    let yesterday = today().previous_day().unwrap().to_string();
    assert_eq!(
        cases,
        vec![
            ("CLOSURE".into(), yesterday.clone()),
            ("INSOLVENCY".into(), yesterday)
        ]
    );
    assert_eq!(common::placed_at(&owner, s.park).await, s.w.hq);
    assert_eq!(
        close_support::closed_on(&owner, "workplaces", s.w.branch).await,
        None
    );
    // Nothing more happens while they have not left.
    assert_eq!(s.tick(today()).await, 0);
    assert_eq!(state(&owner, job.id).await, "WAITING");
    // Once their exits are in effect, the tick dissolves the 부서 and closes the 사업장.
    exited(&owner, &[s.kim, s.lee]).await;
    assert_eq!(s.tick(today()).await, 1);
    assert_eq!(state(&owner, job.id).await, "APPLIED");
    assert_eq!(
        close_support::closed_on(&owner, "workplaces", s.w.branch).await,
        Some(today())
    );
    assert_eq!(common::unit_head(&owner, s.qa).await.1, "dissolved");
}
