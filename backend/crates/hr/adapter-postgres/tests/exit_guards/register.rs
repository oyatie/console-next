// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_hr_adapter_postgres::exits::preflight::ExitGuardsQuery;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn protection_tail_is_recomputed_from_the_register_for_preflight_and_report(pool: PgPool) {
    let w = live(&pool).await;
    leave(&w, w.in_a, "MATERNITY", "2026-10-09", Some("2026-10-12")).await;
    w.hr.record_lifecycle_event(
        w.hr(w.hr_one),
        w.in_a,
        Uuid::new_v4().to_string(),
        serde_json::from_value(json!({
            "event_type":"RETURN_FROM_LEAVE", "effective_date":"2026-10-12",
            "comment":"합성 복직", "signoffs":acks()
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let query = || ExitGuardsQuery {
        effective_exit_date: "2026-10-13".into(),
        exit_reason_code: Some("ADVISED_RESIGNATION_FAULT".into()),
        dismissal_notice_served_on: None,
    };
    let before =
        w.hr.employee_exit_guards(w.hr(w.hr_one), w.in_a, query())
            .await
            .unwrap();
    assert_eq!(before.refusal_code, Some("exit_protected_period"));
    assert!(!before.notice_required);
    assert_eq!(before.protected_periods.len(), 1);
    let before_rule =
        serde_json::to_value(before.protected_periods[0].rule.as_ref().unwrap()).unwrap();
    assert_eq!(before_rule["release_disposition"], "HOLD");
    assert!(
        before_rule["source_url"]
            .as_str()
            .unwrap()
            .contains("law.go.kr")
    );
    assert!(
        before_rule["article"]
            .as_str()
            .unwrap()
            .contains("제23조제2항")
    );
    let refused = report(&w, w.in_a, Some("ADVISED_RESIGNATION_FAULT"), "2026-10-13")
        .await
        .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "exit_protected_period")
    );
    assert_eq!(*refused.refusals.unwrap(), json!(before.protected_periods));

    let updated = sqlx::query("UPDATE statutory_rules SET value_num=0 WHERE code='DISMISSAL_PROTECTION_TAIL_DAYS' AND effective_from <= DATE '2026-10-14' AND (effective_to_exclusive IS NULL OR DATE '2026-10-14' < effective_to_exclusive)")
        .execute(&pool).await.unwrap();
    assert_eq!(updated.rows_affected(), 1);
    let after =
        w.hr.employee_exit_guards(w.hr(w.hr_one), w.in_a, query())
            .await
            .unwrap();
    assert_eq!(after.refusal_code, None);
    assert!(after.protected_periods.is_empty());
    let after_rule = &after
        .protection_rules
        .iter()
        .find(|r| r.leave_type == "MATERNITY")
        .unwrap()
        .rule;
    let mut expected_rule = before_rule;
    expected_rule["value"] = json!(0);
    assert_eq!(serde_json::to_value(after_rule).unwrap(), expected_rule);
    let allowed = report(&w, w.in_a, Some("ADVISED_RESIGNATION_FAULT"), "2026-10-13")
        .await
        .unwrap();
    assert_eq!(allowed["status"], "REPORTED");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_retention_deadline_is_recomputed_from_the_register(pool: PgPool) {
    let w = live(&pool).await;
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED',exit_date='2026-10-13' WHERE id=$1",
    )
    .bind(w.in_a)
    .execute(&pool)
    .await
    .unwrap();
    let before =
        w.hr.employee_detail(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .retention
            .unwrap();
    let years = before.rule.value.unwrap() + 1;
    let updated = sqlx::query("UPDATE statutory_rules SET value_num=$1 WHERE code='EMPLOYMENT_RECORD_RETENTION_YEARS' AND effective_from <= DATE '2026-10-13' AND (effective_to_exclusive IS NULL OR DATE '2026-10-13' < effective_to_exclusive)")
        .bind(years).execute(&pool).await.unwrap();
    assert_eq!(updated.rows_affected(), 1);
    let after =
        w.hr.employee_detail(w.hr(w.hr_one), w.in_a)
            .await
            .unwrap()
            .retention
            .unwrap();
    assert_ne!(after.kept_until, before.kept_until);
    assert_eq!(
        after.kept_until,
        Some(
            console_hr_domain::registration_void::register_kept_until(
                date!(2026 - 10 - 13),
                i32::try_from(years).unwrap()
            )
            .to_string()
        )
    );
    let mut expected_rule = serde_json::to_value(&before.rule).unwrap();
    expected_rule["value"] = json!(years);
    assert_eq!(serde_json::to_value(&after.rule).unwrap(), expected_rule);
    assert_eq!(after.rule.release_disposition, "HOLD");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cancellation_copy_receives_the_actual_void_basis_and_recorded_period(pool: PgPool) {
    let w = live(&pool).await;
    let before =
        w.hr.employee_end_options(&w.hr(w.hr_one), w.in_a)
            .await
            .unwrap();
    assert_eq!(before.void_basis, Some("ATTESTED_WITHIN_WINDOW"));
    assert_eq!(before.recorded_hire_date.as_deref(), Some("2025-01-01"));
    assert!(before.attestation_required);
    leave(&w, w.in_a, "WORK_INJURY", "2026-10-09", None).await;
    let after =
        w.hr.employee_end_options(&w.hr(w.hr_one), w.in_a)
            .await
            .unwrap();
    assert!(!after.attestation_required);
    assert_eq!(after.void_basis, None);
    assert_eq!(after.cancel.refusal, Some("employee_void_has_work_records"));
}
