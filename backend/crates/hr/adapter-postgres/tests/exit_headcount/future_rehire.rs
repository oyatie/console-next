// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_hr_adapter_postgres::directory::create_rehire_input::RehireEmployeeRequest;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_writer_recorded_future_rehire_waits_and_preserves_the_original_period(owner: PgPool) {
    let w = world(&owner).await;
    let last_day = w.today - Duration::days(5);
    let case = w.confirm(last_day).await;
    let hired = w.today + Duration::days(10);
    let principal = Principal::new(
        w.actor.user,
        w.actor.org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let request: RehireEmployeeRequest = serde_json::from_value(json!({
        "hire_date": hired.to_string(), "employment_type": "REGULAR", "org_unit_id": w.unit,
        "position": "사원", "phone": "010-1234-5678", "base_pay_won": 3_000_000,
        "pay_unit": "MONTHLY", "acknowledge_open_exit_case": true,
        "idempotency_key": Uuid::new_v4().to_string(),
    }))
    .unwrap();
    let refused =
        w.hr.rehire_employee(principal.clone(), w.employee, request.clone())
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "rehire_exit_case_open")
    );
    assert_eq!(refused.refusals.unwrap()[0]["decision_final"], false);
    w.hr.confirm_exit_case(
        principal.clone(),
        None,
        case,
        serde_json::from_value(json!({ "hq_confirmation": true })).unwrap(),
    )
    .await
    .unwrap();
    let mut unacknowledged = request.clone();
    unacknowledged.acknowledge_open_exit_case = false;
    let refused =
        w.hr.rehire_employee(principal.clone(), w.employee, unacknowledged)
            .await
            .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "rehire_exit_case_open")
    );
    assert_eq!(
        refused.refusals.unwrap()[0]["acknowledgement_required"],
        true
    );
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
