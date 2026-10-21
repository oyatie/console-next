//! Every schedule-store refusal code from a real request, and nothing written.

use super::support::{assign, code, key, office, rows, world};

use console_attendance_application::schedule::ReasonInput;
use console_attendance_domain::schedule::Level;
use sqlx::PgPool;
use time::macros::date;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn pattern_and_layer_refusals(owner: PgPool) {
    let w = world(owner).await;
    let hr = w.hr();
    assert_eq!(
        code(w.store.create_pattern(&hr, "short", office("x")).await),
        "idempotency_key_invalid"
    );
    let mut bad = office("x");
    bad.days = Some(serde_json::json!([{"kind": "NAP"}]));
    assert_eq!(
        code(w.store.create_pattern(&hr, &key(), bad).await),
        "pattern_input_invalid"
    );
    let missing = assign(
        Level::Workplace,
        w.workplaces[0],
        Uuid::new_v4(),
        date!(2026 - 11 - 01),
    );
    assert_eq!(
        code(w.store.preview_schedule(&hr, missing).await),
        "pattern_not_found"
    );

    let (p, _) = w
        .store
        .create_pattern(&hr, &key(), office("사무"))
        .await
        .unwrap();
    assert_eq!(
        code(
            w.store
                .preview_schedule(
                    &hr,
                    assign(
                        Level::Department,
                        Uuid::new_v4(),
                        p.id,
                        date!(2026 - 11 - 01)
                    )
                )
                .await
        ),
        "scope_not_found"
    );
    let mut none = assign(
        Level::Workplace,
        w.workplaces[0],
        p.id,
        date!(2026 - 11 - 01),
    );
    none.targets.clear();
    assert_eq!(
        code(w.store.preview_schedule(&hr, none).await),
        "targets_invalid"
    );
    let mut reason = assign(
        Level::Workplace,
        w.workplaces[0],
        p.id,
        date!(2026 - 11 - 01),
    );
    reason.reason = "WHIM".into();
    assert_eq!(
        code(w.store.preview_schedule(&hr, reason).await),
        "reason_invalid"
    );
    let mut range = assign(
        Level::Workplace,
        w.workplaces[0],
        p.id,
        date!(2027 - 11 - 01),
    );
    range.effective_to = Some(date!(2027 - 10 - 01));
    assert_eq!(
        code(w.store.assign_schedule(&hr, &key(), range).await),
        "effective_range_invalid"
    );
    let mut choice = assign(Level::Person, w.people[0], p.id, date!(2027 - 11 - 01));
    choice.targets[0].start_choice = Some(600);
    assert_eq!(
        code(w.store.assign_schedule(&hr, &key(), choice).await),
        "start_choice_invalid"
    );

    let (layer, _) = w
        .store
        .assign_schedule(
            &hr,
            &key(),
            assign(
                Level::Workplace,
                w.workplaces[0],
                p.id,
                date!(2027 - 11 - 01),
            ),
        )
        .await
        .unwrap();
    let id = layer.layers[0].id;
    assert_eq!(
        code(
            w.store
                .cancel_layer(&hr, id, ReasonInput { reason: " ".into() })
                .await
        ),
        "reason_required"
    );
    assert_eq!(
        code(
            w.store
                .cancel_layer(&hr, Uuid::new_v4(), ReasonInput { reason: "x".into() })
                .await
        ),
        "layer_not_found"
    );
    w.store
        .cancel_layer(&hr, id, ReasonInput { reason: "x".into() })
        .await
        .unwrap();
    assert_eq!(
        code(
            w.store
                .cancel_layer(&hr, id, ReasonInput { reason: "x".into() })
                .await
        ),
        "layer_already_cancelled"
    );

    w.store.retire_pattern(&hr, p.id).await.unwrap();
    let retired = assign(
        Level::Workplace,
        w.workplaces[0],
        p.id,
        date!(2027 - 12 - 01),
    );
    assert_eq!(
        code(w.store.assign_schedule(&hr, &key(), retired).await),
        "pattern_retired"
    );
    assert_eq!(
        code(
            w.store
                .schedule_calendar(&hr, Level::Workplace, w.workplaces[0], "2026-13".into())
                .await
        ),
        "month_invalid"
    );
    assert_eq!(
        rows(&w, "attendance_schedule_layers").await,
        1,
        "only the cancelled layer"
    );
}
