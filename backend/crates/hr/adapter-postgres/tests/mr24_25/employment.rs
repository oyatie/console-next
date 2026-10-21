//! The dated 고용형태 전환 (MR-24).

use serde_json::json;
use sqlx::PgPool;

use crate::{event, fixture};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_employment_type_change_is_dated_and_keeps_the_window(pool: PgPool) {
    let f = fixture(pool).await;
    let imported = f.employee(None).await;
    let regular = json!({"to_employment_type": "REGULAR"});
    assert_eq!(
        f.record(
            imported,
            event("EMPLOYMENT_TYPE_CHANGE", "2026-09-01", regular.clone())
        )
        .await
        .unwrap_err(),
        (409, "employment_profile_missing".to_owned())
    );
    let e = f.employee(Some("CONTRACT")).await;
    let converted = f
        .record(
            e,
            event("EMPLOYMENT_TYPE_CHANGE", "2026-09-01", regular.clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            converted["from_employment_type"].as_str(),
            converted["to_status"].as_str()
        ),
        (Some("CONTRACT"), Some("ACTIVE"))
    );
    assert_eq!(f.employment(e).await, ("REGULAR".to_owned(), None, None));
    let noop = f
        .record(e, event("EMPLOYMENT_TYPE_CHANGE", "2026-09-02", regular))
        .await;
    assert_eq!(noop.unwrap_err(), (422, "lifecycle_noop".to_owned()));
    f.rescind(e, &converted).await;
    let window = (Some("2025-01-02".to_owned()), Some("2026-12-31".to_owned()));
    assert_eq!(
        f.employment(e).await,
        ("CONTRACT".to_owned(), window.0.clone(), window.1.clone())
    );

    // Scheduled: back to REGULAR; a renewal after it meets the projected
    // REGULAR head and is refused; then CONTRACT again, applied on its date.
    assert_eq!(
        f.record(
            e,
            event(
                "EMPLOYMENT_TYPE_CHANGE",
                "2027-03-01",
                json!({"to_employment_type": "CONTRACT"})
            )
        )
        .await
        .unwrap_err()
        .0,
        422
    );
    f.record(
        e,
        event(
            "EMPLOYMENT_TYPE_CHANGE",
            "2027-01-01",
            json!({"to_employment_type": "REGULAR"}),
        ),
    )
    .await
    .unwrap();
    let renewal = event(
        "CONTRACT_RENEWAL",
        "2027-02-01",
        json!({"contract_end_date": "2027-12-31"}),
    );
    assert_eq!(
        f.record(e, renewal).await.unwrap_err(),
        (409, "invalid_transition".to_owned())
    );
    let to_contract = json!({"to_employment_type": "CONTRACT", "contract_end_date": "2027-12-31"});
    let later = f
        .record(
            e,
            event("EMPLOYMENT_TYPE_CHANGE", "2027-03-01", to_contract),
        )
        .await
        .unwrap();
    assert_eq!(later["state"], "SCHEDULED");
    let on = time::Date::from_calendar_date(2027, time::Month::March, 1).unwrap();
    f.hr.apply_due(on).await.unwrap();
    assert_eq!(
        f.employment(e).await,
        (
            "CONTRACT".to_owned(),
            Some("2027-03-01".to_owned()),
            Some("2027-12-31".to_owned())
        )
    );
    // The window the first 전환 closed still counts toward 기간제법 §4 (MR-24).
    let service =
        f.hr.employee_fixed_term(f.principal.clone(), e)
            .await
            .unwrap();
    assert_eq!(service.basis, Some("CONTRACT_HISTORY"));
    assert!(service.cumulative_days.unwrap() > 600, "{service:?}");
}
