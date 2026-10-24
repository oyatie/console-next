// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_writer_recorded_future_rehire_waits_and_preserves_the_original_period(owner: PgPool) {
    let w = world(&owner).await;
    let last_day = w.today - Duration::days(5);
    w.confirm(last_day).await;
    let hired = w.today + Duration::days(10);
    let principal = Principal::new(
        w.actor.user,
        w.actor.org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let request = serde_json::from_value(json!({
        "hire_date": hired.to_string(), "employment_type": "REGULAR", "org_unit_id": w.unit,
        "position": "사원", "phone": "010-1234-5678", "base_pay_won": 3_000_000,
        "pay_unit": "MONTHLY", "idempotency_key": Uuid::new_v4().to_string(),
    }))
    .unwrap();
    let (_, detail) =
        w.hr.rehire_employee(principal, w.employee, request)
            .await
            .unwrap();
    assert_eq!(detail.employee.status.as_deref(), Some("PRE_HIRE"));
    assert_eq!(
        detail.employee.hire_date.as_deref(),
        Some(hired.to_string().as_str())
    );
    assert_eq!(w.live().await, 0);
    let cutoff = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&owner)
        .await
        .unwrap();
    for known_at in [None, Some(cutoff)] {
        for (date, expected) in [
            (last_day, 1),
            (last_day + Duration::days(1), 0),
            (w.today, 0),
            (hired - Duration::days(1), 0),
            (hired, 1),
        ] {
            let chart = w
                .store
                .org_structure_at(
                    &w.actor,
                    ReadOptions {
                        as_of: Some(date),
                        known_at,
                    },
                )
                .await
                .unwrap();
            assert_eq!(w.count(&chart), expected, "rehire boundary at {date}");
        }
    }
}
