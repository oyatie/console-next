// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reason_classes_survive_the_validation_call(pool: PgPool) {
    let w = live(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    for (code, involuntary, notice_required) in [
        ("DISCIPLINARY_DISMISSAL", true, true),
        ("ADVISED_RESIGNATION_FAULT", true, false),
        ("PERSONAL", false, false),
    ] {
        let v = validate_reason_in_tx(
            tx.as_mut(),
            OrgId::from_uuid(w.org),
            ReasonDomain::ExitReason,
            code,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            (v.involuntary, v.notice_required),
            (involuntary, notice_required)
        );
    }
    tx.rollback().await.unwrap();
    let raw = sqlx::query("INSERT INTO reason_codes (org_id,domain,code,label_ko,requires_note,created_by,involuntary,notice_required) VALUES ($1,'lifecycle_transfer',$2,'합성',false,$3,true,false)").bind(w.org).bind(format!("T_{:X}",Uuid::new_v4().simple())).bind(w.hr_one).execute(&pool).await;
    assert!(raw.is_err(), "DB class CHECK is authoritative too");
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn protected_report_is_atomic_and_voluntary_exit_is_unchanged(pool: PgPool) {
    let w = live(&pool).await;
    let l = leave(&w, w.in_a, "WORK_INJURY", "2026-10-09", None).await;
    let e = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-10-10")
        .await
        .unwrap_err();
    assert_eq!((e.status.as_u16(), e.code), (409, "exit_protected_period"));
    let refusal = &e.refusals.as_ref().unwrap()[0];
    assert_eq!(refusal["lifecycle_event_id"], l["id"]);
    assert_eq!(refusal["leave_from"], "2026-10-09");
    assert!(refusal["article"].as_str().unwrap().contains("제23조제2항"));
    assert_eq!(count(&pool, "employee_exit_cases", &w).await, 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.exit.report'"
        )
        .bind(w.org)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    let c = report(&w, w.in_a, Some("PERSONAL"), "2026-10-10")
        .await
        .unwrap();
    let c = confirm(&w, &c, json!({})).await.unwrap();
    assert_eq!(c["status"], "HR_CONFIRMED");
    assert_eq!(c["involuntary"], false);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT employment_status FROM employees WHERE id=$1")
            .bind(w.in_a)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "EXITED"
    );
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn late_reason_inside_childcare_is_refused_without_effect(pool: PgPool) {
    let w = live(&pool).await;
    leave(&w, w.in_a, "CHILDCARE", "2026-09-20", Some("2027-01-01")).await;
    let c = report(&w, w.in_a, None, "2026-10-10").await.unwrap();
    let e = confirm(
        &w,
        &c,
        json!({"exit_reason_code":"ADVISED_RESIGNATION_FAULT"}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, "exit_protected_period");
    let register = console_compliance_adapter_postgres::statutory::load_statutory_register(
        &mut pool.acquire().await.unwrap(),
    )
    .await
    .unwrap();
    let out =
        w.hr.exit_case(
            w.hr(w.hr_one),
            c["id"].as_str().unwrap().parse().unwrap(),
            &register,
        )
        .await
        .unwrap();
    assert_eq!(out.status, "REPORTED");
    assert!(!out.protected_periods.is_empty());
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn work_injury_is_stored_and_unknown_leave_stays_invalid(pool: PgPool) {
    let w = live(&pool).await;
    let l = leave(&w, w.in_a, "WORK_INJURY", "2026-10-09", None).await;
    assert_eq!(l["leave_type"], "WORK_INJURY");
    let raw = sqlx::query("INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,to_status,effective_date,comment,created_by,leave_type) VALUES ($1,$2,'LEAVE_OF_ABSENCE','ON_LEAVE','2026-10-10','합성',$3,'VACATION')")
        .bind(w.org).bind(w.in_b).bind(w.hr_one).execute(&pool).await.unwrap_err();
    assert_eq!(
        raw.as_database_error().unwrap().constraint(),
        Some("employee_lifecycle_events_leave_type_check")
    );
}
