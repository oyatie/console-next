//! Every schedule-store refusal code from a real request, and nothing written.

use super::support::{World, code, key, rows, world};

use console_attendance_application::calendar::{
    CrewInput, CrewMembersInput, HolidayInput, HolidayRetireInput,
};

use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

fn holiday(w: &World) -> HolidayInput {
    HolidayInput {
        name: "창립기념일".into(),
        rule_kind: "DATE".into(),
        on_date: Some(date!(2026 - 03 - 15)),
        month: None,
        day: None,
        paid: true,
        scope_kind: "LEGAL_ENTITY".into(),
        scope_id: w.entity,
        basis_kind: "WORK_RULES".into(),
        basis_ref: "제40조".into(),
        start_year: 2026,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn crew_and_holiday_refusals(owner: PgPool) {
    let w = world(owner).await;
    let hr = w.hr();
    let crew = |name: &str| CrewInput {
        workplace_id: w.workplaces[0],
        name: name.into(),
    };
    assert_eq!(
        code(w.store.create_crew(&hr, &key(), crew(" ")).await),
        "crew_name_invalid"
    );
    let (a, _) = w.store.create_crew(&hr, &key(), crew("A조")).await.unwrap();
    assert_eq!(
        code(w.store.create_crew(&hr, &key(), crew("a조")).await),
        "crew_name_taken"
    );
    let (b, _) = w.store.create_crew(&hr, &key(), crew("B조")).await.unwrap();
    let place = |ids: Vec<Uuid>, d| CrewMembersInput {
        employee_ids: ids,
        valid_from: d,
    };
    assert_eq!(
        code(
            w.store
                .place_crew_members(&hr, a.id, &key(), place(vec![], date!(2026 - 11 - 01)))
                .await
        ),
        "crew_members_invalid"
    );
    assert_eq!(
        code(
            w.store
                .place_crew_members(
                    &hr,
                    Uuid::new_v4(),
                    &key(),
                    place(vec![w.people[0]], date!(2026 - 11 - 01))
                )
                .await
        ),
        "crew_not_found"
    );
    // A later move is planned; an earlier one that would overlap it is refused.
    w.store
        .place_crew_members(
            &hr,
            a.id,
            &key(),
            place(vec![w.people[0]], date!(2026 - 12 - 01)),
        )
        .await
        .unwrap();
    assert_eq!(
        code(
            w.store
                .place_crew_members(
                    &hr,
                    b.id,
                    &key(),
                    place(vec![w.people[0]], date!(2026 - 11 - 01))
                )
                .await
        ),
        "crew_membership_overlap"
    );
    assert_eq!(rows(&w, "attendance_crew_members").await, 1);

    let mut wrong = holiday(&w);
    wrong.on_date = Some(date!(2025 - 03 - 15));
    assert_eq!(
        code(w.store.preview_holiday(&hr, wrong).await),
        "holiday_rule_invalid"
    );
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, branch_id, checks, attested_by) VALUES ($1, '2026-03-01', $2, '{}', $3)")
        .bind(w.org).bind(w.branches[0]).bind(w.admin).execute(&w.owner).await.unwrap();
    assert_eq!(
        code(w.store.create_holiday(&hr, &key(), holiday(&w)).await),
        "holiday_month_closed"
    );
    assert_eq!(
        code(
            w.store
                .retire_holiday(&hr, Uuid::new_v4(), HolidayRetireInput { from_year: 2027 })
                .await
        ),
        "holiday_not_found"
    );
    let mut later = holiday(&w);
    later.on_date = Some(date!(2027 - 03 - 15));
    later.start_year = 2027;
    let (h, _) = w.store.create_holiday(&hr, &key(), later).await.unwrap();
    assert_eq!(
        code(
            w.store
                .retire_holiday(&hr, h.id, HolidayRetireInput { from_year: 2020 })
                .await
        ),
        "holiday_retire_year_invalid"
    );
    assert_eq!(rows(&w, "attendance_contractual_holidays").await, 1);
}
