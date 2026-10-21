//! A later 폐쇄일: checked now (a dry run on the day, rolled back), nothing
//! moves before the day, the tick applies it on the day; one open job per
//! 사업장, and a planned close can be withdrawn.

use serde_json::json;
use sqlx::PgPool;
use time::Duration;

use crate::close_support;
use crate::common;
use crate::fixture::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_later_close_moves_nothing_before_its_day_and_applies_on_it(owner: PgPool) {
    let s = Site::new(&owner).await;
    let day = today() + Duration::days(3);
    let plan = json!({
        "closed_on": day.to_string(),
        "units": [
            { "org_unit_id": s.dev, "action": "MOVE", "to_parent_id": s.hr_team },
            { "org_unit_id": s.logistics, "action": "DISSOLVE" },
        ],
        "people": [
            { "employee_id": s.kim, "action": "TRANSFER", "to_org_unit_id": s.dev },
            { "employee_id": s.lee, "action": "TRANSFER", "to_org_unit_id": s.qa },
            { "employee_id": s.park, "action": "TRANSFER", "to_org_unit_id": s.hq_unit },
            { "employee_id": s.choi, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
        ],
    });
    let job = s.plan(plan.clone()).await.unwrap();
    assert_eq!(job.state, "SCHEDULED");
    // The dry run left no trace: nobody moved, no 전근 recorded, 개발팀 where it was.
    assert_eq!(nothing_written(&owner).await.1, 0);
    assert_eq!(common::placed_at(&owner, s.kim).await, s.w.branch);
    assert_eq!(
        common::unit_head(&owner, s.dev).await.2,
        Some(s.branch_unit.to_string())
    );

    // One open close per 사업장.
    let e = s.plan(plan.clone()).await.unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (409, "close_job_open"));

    // Not due yet; on the day the tick applies it.
    assert_eq!(s.tick(today()).await, 0);
    assert_eq!(state(&owner, job.id).await, "SCHEDULED");
    assert_eq!(s.tick(day).await, 1);
    assert_eq!(state(&owner, job.id).await, "APPLIED");
    assert_eq!(
        close_support::closed_on(&owner, "workplaces", s.w.branch).await,
        Some(day)
    );
    assert_eq!(
        common::unit_head(&owner, s.dev).await.2,
        Some(s.hr_team.to_string())
    );
    for e in [s.kim, s.lee, s.park, s.choi] {
        assert_eq!(common::placed_at(&owner, e).await, s.w.hq, "{e}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_planned_close_is_withdrawn_and_can_be_planned_again(owner: PgPool) {
    let s = Site::new(&owner).await;
    let day = today() + Duration::days(1);
    let plan = json!({
        "closed_on": day.to_string(),
        "units": [{ "org_unit_id": s.dev, "action": "DISSOLVE" }, { "org_unit_id": s.logistics, "action": "DISSOLVE" }],
        "people": [
            { "employee_id": s.kim, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
            { "employee_id": s.lee, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
            { "employee_id": s.park, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
            { "employee_id": s.choi, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
        ],
    });
    let job = s.plan(plan.clone()).await.unwrap();
    let cancelled =
        s.hr.cancel_workplace_close(s.planner(uuid::Uuid::new_v4()), s.w.branch)
            .await
            .unwrap();
    assert_eq!(
        (cancelled.id, cancelled.state.as_str()),
        (job.id, "CANCELLED")
    );
    // Nothing open: a second cancel is refused, and the tick never applies a cancelled job.
    let e =
        s.hr.cancel_workplace_close(s.planner(uuid::Uuid::new_v4()), s.w.branch)
            .await
            .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (409, "close_job_not_open"));
    assert_eq!(s.tick(day).await, 0);
    assert_eq!(
        close_support::closed_on(&owner, "workplaces", s.w.branch).await,
        None
    );
    // The read shows the 사업장's people and 부서, and the planner may plan again.
    let view =
        s.hr.workplace_close_plan(s.planner(uuid::Uuid::new_v4()).org, s.w.branch)
            .await
            .unwrap();
    assert_eq!((view.people.len(), view.units.len()), (4, 3));
    assert_eq!(s.plan(plan).await.unwrap().state, "SCHEDULED");
    assert_eq!(audits(&owner, "workplace.close_job.cancel").await, 1);
}
