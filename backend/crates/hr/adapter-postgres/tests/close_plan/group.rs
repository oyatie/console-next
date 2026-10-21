//! A close moves people to another 법인 by 전적 (decisions #30): the line
//! carries the person's consent and continuity, the plan records the 전적
//! with the sending 법인's settlement case, and the close waits for it to
//! take effect. A line that cannot be a 전적 refuses the plan, writing nothing.

use serde_json::{Value, json};
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

use console_hr_adapter_postgres::authz::APPOINTMENT_KEYS;
use console_kernel_core::BranchScope;
use console_platform_authz::Principal;
use console_platform_authz::access::{NodeKind, ScopeGrant};

use crate::close_support::World;
use crate::common::{certificate, cmd, corporation, port, workplace_from};
use crate::fixture::*;

/// 주식회사 나라 and its 물류센터: `(workplace, its own unit)`.
async fn other_entity(w: &World) -> (Uuid, Uuid) {
    let entity = w
        .store
        .create_entity(
            &cmd(&w.actor),
            corporation("주식회사 나라", "000211-0006259"),
        )
        .await
        .unwrap()
        .record
        .id;
    let reg = w
        .store
        .create_registration(&cmd(&w.actor), entity, certificate("000-81-00071"))
        .await
        .unwrap()
        .record
        .id;
    let wp = w
        .store
        .create_workplace(
            &cmd(&w.actor),
            entity,
            workplace_from(reg, "물류센터"),
            port(),
        )
        .await
        .unwrap()
        .record;
    (wp.id, wp.org_unit_id.unwrap())
}

fn facts() -> Value {
    json!({
        "continuity": "SETTLED", "annual_leave_continuity": "SETTLED", "seniority_continuity": "RESTART",
        "group_service_start_date": "2026-01-02", "consent_date": today().to_string(),
        "consent_evidence_ref": "전적 동의서 (서명본)",
    })
}

fn plan(s: &Site, on: &str, kim: Value) -> Value {
    json!({
        "closed_on": on,
        "units": [{ "org_unit_id": s.dev, "action": "DISSOLVE" }, { "org_unit_id": s.logistics, "action": "DISSOLVE" }],
        "people": [
            kim,
            { "employee_id": s.lee, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
            { "employee_id": s.park, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
            { "employee_id": s.choi, "action": "TRANSFER", "to_org_unit_id": s.hr_team },
        ],
    })
}

/// `(state, settlement case)` of each 전적 recorded for `employee`.
async fn group_transfers(owner: &PgPool, employee: Uuid) -> Vec<(String, Option<String>)> {
    sqlx::query_as(
        "SELECT l.state, (SELECT c.status FROM employee_exit_cases c WHERE c.exit_lifecycle_event_id = l.id) \
         FROM employee_lifecycle_events l WHERE l.employee_id = $1 AND l.event_type = 'GROUP_TRANSFER'",
    )
    .bind(employee)
    .fetch_all(owner)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_close_moves_a_person_to_another_entity_by_group_transfer(owner: PgPool) {
    let s = Site::new(&owner).await;
    let (b, b_unit) = other_entity(&s.w).await;
    let on = today().to_string();
    let kim = json!({ "employee_id": s.kim, "action": "GROUP_TRANSFER", "to_org_unit_id": b_unit,
        "to_workplace_id": b, "group_transfer": facts() });
    let job = s.plan(plan(&s, &on, kim)).await.unwrap();
    assert_eq!(job.state, "APPLIED", "{job:?}");
    let line = job
        .lines
        .iter()
        .find(|l| l.employee_id == Some(s.kim))
        .unwrap();
    assert_eq!(
        (line.action.as_str(), line.target_workplace_id),
        ("GROUP_TRANSFER", Some(b))
    );
    assert!(
        line.done,
        "the close reaches APPLIED only after this line is done"
    );
    assert!(line.lifecycle_event_id.is_some() && line.exit_case_id.is_some());
    assert_eq!(crate::common::placed_at(&owner, s.kim).await, b);
    assert_eq!(
        group_transfers(&owner, s.kim).await,
        [("APPLIED".to_owned(), Some("HR_CONFIRMED".to_owned()))]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_n_minus_one_close_update_cannot_apply_before_group_transfer_is_done(owner: PgPool) {
    let s = Site::new(&owner).await;
    let (b, b_unit) = other_entity(&s.w).await;
    let day = today() + Duration::days(1);
    let kim = json!({ "employee_id": s.kim, "action": "GROUP_TRANSFER", "to_org_unit_id": b_unit,
        "to_workplace_id": b, "group_transfer": facts() });
    let job = s.plan(plan(&s, &day.to_string(), kim)).await.unwrap();
    let line = job
        .lines
        .iter()
        .find(|line| line.employee_id == Some(s.kim))
        .unwrap();
    assert_eq!(
        (job.state.as_str(), line.action.as_str(), line.done),
        ("SCHEDULED", "GROUP_TRANSFER", false)
    );

    // This is the N-1 rows::set_state UPDATE from e68a03f04.
    let err = sqlx::query(
        "UPDATE workplace_close_jobs SET state = $2, failure = $3, \
           settled_at = CASE WHEN $2 IN ('APPLIED', 'FAILED', 'CANCELLED') THEN now() ELSE NULL END \
         WHERE id = $1",
    )
    .bind(job.id)
    .bind("APPLIED")
    .bind(None::<Value>)
    .execute(&owner)
    .await
    .unwrap_err();
    let db_error = err.as_database_error().unwrap();
    assert_eq!(db_error.code().as_deref(), Some("23514"));
    assert_eq!(
        db_error.constraint(),
        Some("workplace_close_jobs_group_transfer_done")
    );
    assert_eq!(state(&owner, job.id).await, "SCHEDULED");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_scheduled_close_waits_for_its_group_transfer(owner: PgPool) {
    let s = Site::new(&owner).await;
    let (b, b_unit) = other_entity(&s.w).await;
    let day = today() + Duration::days(1);
    let kim = json!({ "employee_id": s.kim, "action": "GROUP_TRANSFER", "to_org_unit_id": b_unit,
        "to_workplace_id": b, "group_transfer": facts() });
    let job = s.plan(plan(&s, &day.to_string(), kim)).await.unwrap();
    assert_eq!(job.state, "SCHEDULED");
    // Recorded with the plan: reserved, its settlement case open at once.
    assert_eq!(
        group_transfers(&owner, s.kim).await,
        [("SCHEDULED".to_owned(), Some("HR_CONFIRMED".to_owned()))]
    );
    // On the day, the close waits until the 전적 has taken effect.
    s.tick(day).await;
    assert_eq!(state(&owner, job.id).await, "WAITING");
    s.hr.apply_due(day).await.unwrap();
    assert_eq!(s.tick(day).await, 1);
    assert_eq!(state(&owner, job.id).await, "APPLIED");
    assert_eq!(crate::common::placed_at(&owner, s.kim).await, b);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_line_that_cannot_be_a_group_transfer_refuses_the_plan_writing_nothing(owner: PgPool) {
    let s = Site::new(&owner).await;
    let (b, b_unit) = other_entity(&s.w).await;
    let on = today().to_string();
    let mut body = plan(
        &s,
        &on,
        json!({ "employee_id": s.kim, "action": "GROUP_TRANSFER", "to_org_unit_id": b_unit, "to_workplace_id": b }),
    );
    body["people"][1] = json!({ "employee_id": s.lee, "action": "GROUP_TRANSFER", "to_org_unit_id": s.hr_team,
        "to_workplace_id": s.w.hq, "group_transfer": facts() });
    body["people"][2] = json!({ "employee_id": s.park, "action": "GROUP_TRANSFER", "to_org_unit_id": b_unit,
        "to_workplace_id": s.w.hq, "group_transfer": facts() });
    body["people"][3] =
        json!({ "employee_id": s.choi, "action": "TRANSFER", "to_org_unit_id": b_unit });
    let e = s.plan(body).await.unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (422, "close_plan_refused"));
    let mut want = vec![
        // No consent, no continuity: the 전적's own refusal.
        (s.kim.to_string(), "validation".to_owned()),
        (s.lee.to_string(), "group_transfer_same_entity".to_owned()),
        (s.park.to_string(), "org_unit_at_other_workplace".to_owned()),
        // A 전근 never crosses 법인: the remedy is the 전적 line.
        (s.choi.to_string(), "transfer_cross_entity".to_owned()),
    ];
    want.sort();
    assert_eq!(named(&e), want);
    assert_eq!(nothing_written(&owner).await, (0, 0, 0, 0));
    assert!(group_transfers(&owner, s.kim).await.is_empty());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_planner_whose_grant_stops_at_the_sending_entity_cannot_plan_a_group_transfer(
    owner: PgPool,
) {
    let s = Site::new(&owner).await;
    let (b, b_unit) = other_entity(&s.w).await;
    let on = today().to_string();
    // 인사 발령 over the sending 법인 only, nowhere else.
    let mut who = s.planner(Uuid::new_v4());
    let grants = APPOINTMENT_KEYS
        .map(|feature| ScopeGrant {
            feature,
            kind: NodeKind::LegalEntity,
            id: s.w.entity,
        })
        .to_vec();
    who.principal = Principal::new(who.user, who.org, Default::default(), BranchScope::All)
        .with_scope_grants(grants);
    let parse = |body: Value| serde_json::from_value(body).unwrap();
    let kim = json!({ "employee_id": s.kim, "action": "GROUP_TRANSFER", "to_org_unit_id": b_unit, "to_workplace_id": b, "group_transfer": facts() });
    let e =
        s.hr.plan_workplace_close(who.clone(), s.w.branch, parse(plan(&s, &on, kim)), port())
            .await
            .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (403, "out_of_scope"));
    // The same plan without the 전적 passes their grant and meets the line's own refusal: the 403 is the receiving place's.
    let transfer = json!({ "employee_id": s.kim, "action": "TRANSFER", "to_org_unit_id": b_unit });
    let e =
        s.hr.plan_workplace_close(who, s.w.branch, parse(plan(&s, &on, transfer)), port())
            .await
            .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (422, "close_plan_refused"));
    assert_eq!(nothing_written(&owner).await, (0, 0, 0, 0));
    assert!(group_transfers(&owner, s.kim).await.is_empty());
}
