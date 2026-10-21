//! 근무 일정 (ATT S1) against Postgres with RLS: patterns, layers and their
//! precedence, cancel before effect, refusals that write nothing, holidays.

use super::support::{assign, future, key, office, refused, today, world};

use console_attendance_application::schedule::ReasonInput;
use console_attendance_domain::schedule::{DayKind, Level, ScheduleRefusal};
use sqlx::PgPool;
use time::macros::date;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_pattern_is_validated_named_once_and_replayed_by_its_key(owner: PgPool) {
    let w = world(owner).await;
    let k = key();
    let (p, fresh) = w
        .store
        .create_pattern(&w.hr(), &k, office("주 5일 09–18"))
        .await
        .unwrap();
    assert!(fresh);
    assert_eq!(
        (p.weekly_minutes, p.cycle_days, p.status.as_str()),
        (2400, 7, "ACTIVE")
    );
    let (again, fresh) = w
        .store
        .create_pattern(&w.hr(), &k, office("주 5일 09–18"))
        .await
        .unwrap();
    assert_eq!((again.id, fresh), (p.id, false));
    let taken = w
        .store
        .create_pattern(&w.hr(), &key(), office("주 5일 09–18"))
        .await
        .unwrap_err();
    assert_eq!(refused(taken), "pattern_name_taken");
    let reused = w
        .store
        .create_pattern(&w.hr(), &k, office("다른 이름"))
        .await
        .unwrap_err();
    assert_eq!(refused(reused), "idempotency_key_reused");

    let mut flex = office("탄력 2주");
    flex.kind = "FLEXIBLE".into();
    assert_eq!(
        refused(
            w.store
                .create_pattern(&w.hr(), &key(), flex)
                .await
                .unwrap_err()
        ),
        "regime_not_supported_yet"
    );
    let mut short_break = office("휴게 30분");
    short_break.days = Some(serde_json::json!([
        {"kind": "WORK", "shift": {"start": 540, "end": 1050, "breaks": [{"start": 720, "end": 750}]}},
        {"kind": "REST_DAY"}, {"kind": "REST_DAY"}, {"kind": "REST_DAY"}, {"kind": "REST_DAY"}, {"kind": "REST_DAY"},
        {"kind": "WEEKLY_HOLIDAY"}
    ]));
    assert_eq!(
        refused(
            w.store
                .create_pattern(&w.hr(), &key(), short_break)
                .await
                .unwrap_err()
        ),
        "break_below_minimum"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance_work_patterns")
        .fetch_one(&w.owner)
        .await
        .unwrap();
    assert_eq!(count, 1, "refusals wrote nothing");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_nearest_layer_decides_and_the_tree_counts_who_has_none(owner: PgPool) {
    let w = world(owner).await;
    let (p, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("사무"))
        .await
        .unwrap();
    let tree = w.store.schedule_tree(&w.hr(), None).await.unwrap();
    assert_eq!((tree.people_total, tree.people_unscheduled), (3, 3));

    let from = date!(2026 - 01 - 01);
    let preview = w
        .store
        .preview_schedule(
            &w.hr(),
            assign(Level::Workplace, w.workplaces[0], p.id, from),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            preview.people_in_scope,
            preview.people_changed,
            preview.unscheduled_after
        ),
        (2, 2, 1)
    );
    assert!(preview.past_from && preview.refusals.is_empty());
    let (receipt, _) = w
        .store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::Workplace, w.workplaces[0], p.id, from),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            receipt.people_changed,
            receipt.layers.len(),
            receipt.layers[0].version
        ),
        (2, 1, 1)
    );

    // A layer on 생산부 (the team's parent) wins over the 사업장 for both people.
    let (dept, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("생산부"))
        .await
        .unwrap();
    let preview = w
        .store
        .preview_schedule(&w.hr(), assign(Level::Department, w.dept, dept.id, from))
        .await
        .unwrap();
    assert_eq!((preview.people_changed, preview.unscheduled_after), (2, 1));
    w.store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::Department, w.dept, dept.id, from),
        )
        .await
        .unwrap();
    // A person layer keeps 윤하준 out of a later 사업장 change.
    w.store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::Person, w.people[0], p.id, from),
        )
        .await
        .unwrap();
    let later = w
        .store
        .preview_schedule(
            &w.hr(),
            assign(Level::Workplace, w.workplaces[0], p.id, future()),
        )
        .await
        .unwrap();
    assert_eq!(later.people_changed, 0);
    assert_eq!(
        later
            .kept
            .iter()
            .map(|k| (k.level, k.people))
            .collect::<Vec<_>>(),
        vec![(Level::Department, 1), (Level::Person, 1)]
    );

    let cal = w
        .store
        .schedule_calendar(&w.hr(), Level::Person, w.people[1], "2026-10".into())
        .await
        .unwrap();
    let day = |d: u8| {
        cal.days
            .iter()
            .find(|x| x.date == date!(2026 - 10 - 01).replace_day(d).unwrap())
            .unwrap()
    };
    assert_eq!(
        (day(1).kind, day(1).decided_by),
        (DayKind::Work, Some(Level::Department))
    );
    assert_eq!(
        day(5).kind,
        DayKind::SubstituteHoliday,
        "10/5 개천절 대체공휴일"
    );
    assert_eq!(day(4).kind, DayKind::WeeklyHoliday);
    assert!(cal.holidays_loaded);
    assert!(
        cal.stack
            .iter()
            .any(|s| s.level == Level::Department && s.wins)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_layer_cancels_only_before_it_takes_effect_and_keeps_its_history(owner: PgPool) {
    let w = world(owner).await;
    let (p, _) = w
        .store
        .create_pattern(&w.hr(), &key(), office("사무"))
        .await
        .unwrap();
    let (now, _) = w
        .store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::Workplace, w.workplaces[0], p.id, today()),
        )
        .await
        .unwrap();
    let (next, _) = w
        .store
        .assign_schedule(
            &w.hr(),
            &key(),
            assign(Level::Workplace, w.workplaces[0], p.id, future()),
        )
        .await
        .unwrap();
    let reason = || ReasonInput {
        reason: "11월 일정은 다시 정합니다".into(),
    };

    let in_effect = w
        .store
        .cancel_layer(&w.hr(), now.layers[0].id, reason())
        .await
        .unwrap_err();
    assert_eq!(refused(in_effect), ScheduleRefusal::LayerInEffect.code());
    let retire = w.store.retire_pattern(&w.hr(), p.id).await.unwrap_err();
    assert_eq!(refused(retire), "pattern_in_use");

    let cancelled = w
        .store
        .cancel_layer(&w.hr(), next.layers[0].id, reason())
        .await
        .unwrap();
    assert_eq!((cancelled.state, cancelled.version), ("CANCELLED", 2));
    let history = w
        .store
        .list_layers(&w.hr(), Level::Workplace, w.workplaces[0])
        .await
        .unwrap();
    assert_eq!(
        history.items.iter().map(|l| l.state).collect::<Vec<_>>(),
        vec!["CANCELLED", "IN_EFFECT"]
    );
    // The database refuses an in-effect cancel and any delete on its own.
    let direct = sqlx::query("UPDATE attendance_schedule_layers SET status = 'CANCELLED', cancel_reason = 'x', cancelled_by = $2, cancelled_at = now() WHERE id = $1")
        .bind(now.layers[0].id).bind(w.admin).execute(&w.owner).await;
    assert!(direct.is_err());
    assert!(
        sqlx::query("DELETE FROM attendance_schedule_layers")
            .execute(&w.owner)
            .await
            .is_err()
    );
}
