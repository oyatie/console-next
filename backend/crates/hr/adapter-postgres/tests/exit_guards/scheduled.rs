// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_exit_rechecks_new_work_injury_and_fails_closed_without_a_case(pool: PgPool) {
    let w = live(&pool).await;
    let today = (time::OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let on = today + Duration::days(20);
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), &on.to_string())
        .await
        .unwrap();
    let c = confirm(
        &w,
        &c,
        json!({"dismissal_notice":notice(&today.to_string())}),
    )
    .await
    .unwrap();
    assert_eq!(c["exit_event_state"], "SCHEDULED");
    leave(&w, w.in_a, "WORK_INJURY", &today.to_string(), None).await;
    // Deliberately orphaned SCHEDULED TERMINATE, as a corrupt legacy row.
    let orphan = Uuid::new_v4();
    sqlx::query("INSERT INTO employee_lifecycle_events (id,org_id,employee_id,event_type,from_status,to_status,effective_date,comment,created_by,state,scheduled_request) SELECT $1,$2,$3,'TERMINATE','ACTIVE','EXITED',$4,'합성',$5,'SCHEDULED',scheduled_request FROM employee_lifecycle_events WHERE id=$6").bind(orphan).bind(w.org).bind(w.in_b).bind(on.to_string()).bind(w.hr_one).bind(c["exit_lifecycle_event_id"].as_str().unwrap().parse::<Uuid>().unwrap()).execute(&pool).await.unwrap();
    w.hr.apply_due(on).await.unwrap();
    for (id, code) in [
        (
            c["exit_lifecycle_event_id"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
            "exit_protected_period",
        ),
        (orphan, "exit_case_required"),
    ] {
        let actual: (String, Option<String>) =
            sqlx::query_as("SELECT state,failure_code FROM employee_lifecycle_events WHERE id=$1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(actual, ("APPLY_FAILED".into(), Some(code.into())));
    }
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT employment_status FROM employees WHERE id=$1")
            .bind(w.in_a)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "ON_LEAVE"
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.lifecycle.apply_failed'").bind(w.org).fetch_one(&pool).await.unwrap(),2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_exit_ignores_a_rescinded_leave_but_rechecks_a_replacement(pool: PgPool) {
    let w = live(&pool).await;
    let today = (time::OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let on = today + Duration::days(20);
    let mut exits = Vec::new();
    for employee in [w.in_a, w.in_b] {
        let c = report(
            &w,
            employee,
            Some("DISCIPLINARY_DISMISSAL"),
            &on.to_string(),
        )
        .await
        .unwrap();
        let c = confirm(
            &w,
            &c,
            json!({"dismissal_notice":notice(&today.to_string())}),
        )
        .await
        .unwrap();
        exits.push(
            c["exit_lifecycle_event_id"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
        );
        let l = leave(
            &w,
            employee,
            "MATERNITY",
            &today.to_string(),
            Some(&(on + Duration::days(10)).to_string()),
        )
        .await;
        w.hr.rescind_lifecycle_event(
            w.hr(w.hr_one),
            employee,
            l["id"].as_str().unwrap().parse().unwrap(),
            serde_json::from_value(json!({"reason_code":"INPUT_ERROR","confirm_cascades":true}))
                .unwrap(),
        )
        .await
        .unwrap();
    }
    leave(
        &w,
        w.in_b,
        "MATERNITY",
        &today.to_string(),
        Some(&(on + Duration::days(10)).to_string()),
    )
    .await;
    w.hr.apply_due(on).await.unwrap();
    for (id, state) in exits.iter().zip(["APPLIED", "APPLY_FAILED"]) {
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT state FROM employee_lifecycle_events WHERE id=$1"
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
            state
        );
    }
}
