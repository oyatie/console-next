//! 근무 일정 (ATT S1) against Postgres with RLS: patterns, layers and their
//! precedence, cancel before effect, refusals that write nothing, holidays.

use super::support::{assign, future, key, office, refused, rows, world};

use console_attendance_domain::schedule::Level;
use sqlx::PgPool;
use time::macros::date;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refusals_write_nothing(owner: PgPool) {
    let w = world(owner).await;
    let (p, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("사무"))
        .await
        .unwrap();
    let month = future().replace_day(1).unwrap();
    sqlx::query("INSERT INTO attendance_month_closes (org_id, month, branch_id, checks, attested_by) VALUES ($1, $2, $3, '{}', $4)")
        .bind(w.org).bind(month).bind(w.branches[0]).bind(w.admin).execute(&w.owner).await.unwrap();
    let closed = w
        .store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::Workplace, w.workplaces[0], p.id, future()),
        )
        .await
        .unwrap_err();
    assert_eq!(refused(closed), "schedule_month_closed");
    // 서울 is not closed, so the same pattern lands there.
    w.store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::Workplace, w.workplaces[1], p.id, future()),
        )
        .await
        .unwrap();

    let mut reduction = assign(Level::Person, w.people[2], p.id, future());
    reduction.reason = "REDUCTION".into();
    assert_eq!(
        refused(
            w.store
                .assign_schedule(&w.hr(), &key(), reduction)
                .await
                .unwrap_err()
        ),
        "evidence_required"
    );
    let mut cover = assign(Level::Workplace, w.workplaces[1], p.id, future());
    cover.reason = "SUBSTITUTE".into();
    assert_eq!(
        refused(
            w.store
                .assign_schedule(&w.hr(), &key(), cover)
                .await
                .unwrap_err()
        ),
        "substitute_needs_end"
    );

    // 서울-only HR cannot touch 평택 or the 법인, and does not see 평택's people.
    let other = w
        .store
        .assign_schedule(
            &w.seoul_hr(),
            &key(),
            assign(Level::Workplace, w.workplaces[0], p.id, future()),
        )
        .await
        .unwrap_err();
    assert_eq!(refused(other), "forbidden");
    let entity = w
        .store
        .preview_schedule(
            &w.seoul_hr(),
            assign(Level::LegalEntity, w.entity, p.id, future()),
        )
        .await
        .unwrap_err();
    assert_eq!(refused(entity), "forbidden");
    assert_eq!(
        w.store
            .schedule_tree(&w.seoul_hr(), None)
            .await
            .unwrap()
            .people_total,
        1
    );
    assert_eq!(rows(&w, "attendance_schedule_layers").await, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn crews_and_contractual_holidays_reach_their_people(owner: PgPool) {
    let w = world(owner).await;
    let (p, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("사무"))
        .await
        .unwrap();
    let (crew, _) = w
        .store
        .create_crew(
            &w.hr(),
            &key(),
            console_attendance_application::calendar::CrewInput {
                workplace_id: w.workplaces[0],
                name: "A조".into(),
            },
        )
        .await
        .unwrap();
    let members = console_attendance_application::calendar::CrewMembersInput {
        employee_ids: vec![w.people[1]],
        valid_from: date!(2026 - 01 - 01),
    };
    let crew = w
        .store
        .place_crew_members(&w.hr(), crew.id, &key(), members)
        .await
        .unwrap();
    assert_eq!(crew.members.len(), 1);
    let wrong = console_attendance_application::calendar::CrewMembersInput {
        employee_ids: vec![w.people[2]],
        valid_from: date!(2026 - 01 - 01),
    };
    assert_eq!(
        refused(
            w.store
                .place_crew_members(&w.hr(), crew.id, &key(), wrong)
                .await
                .unwrap_err()
        ),
        "employee_not_in_workplace"
    );
    let preview = w
        .store
        .preview_schedule(
            &w.hr(),
            assign(Level::Crew, crew.id, p.id, date!(2026 - 01 - 01)),
        )
        .await
        .unwrap();
    assert_eq!(preview.people_changed, 1);

    let input = || console_attendance_application::calendar::HolidayInput {
        name: "창립기념일".into(),
        rule_kind: "YEARLY".into(),
        on_date: None,
        month: Some(10),
        day: Some(9),
        paid: true,
        scope_kind: "WORKPLACE".into(),
        scope_id: w.workplaces[0],
        basis_kind: "WORK_RULES".into(),
        basis_ref: "제40조".into(),
        start_year: 2026,
    };
    let preview = w.store.preview_holiday(&w.hr(), input()).await.unwrap();
    assert_eq!(
        (preview.people, preview.overlaps_public.len()),
        (2, 2),
        "10/9 is 한글날 in both loaded editions, 2026 and 2027"
    );
    let (h, _) = w
        .store
        .create_holiday(&w.hr(), &key(), input())
        .await
        .unwrap();
    assert_eq!(
        w.store
            .holiday_year(&w.hr(), 2026)
            .await
            .unwrap()
            .contractual
            .len(),
        1
    );
    let retired = w
        .store
        .retire_holiday(
            &w.hr(),
            h.id,
            console_attendance_application::calendar::HolidayRetireInput { from_year: 2027 },
        )
        .await
        .unwrap();
    assert_eq!(retired.end_year, Some(2026));
    assert!(
        w.store
            .holiday_year(&w.hr(), 2027)
            .await
            .unwrap()
            .contractual
            .is_empty()
    );
    assert!(!w.store.holiday_year(&w.hr(), 2031).await.unwrap().loaded);
}
