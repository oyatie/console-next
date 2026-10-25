// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn short_notice_requires_a_disposition_before_confirmation(pool: PgPool) {
    let w = live(&pool).await;
    sqlx::query("UPDATE employees SET hire_date='2025-01-01' WHERE id=$1")
        .bind(w.in_a)
        .execute(&pool)
        .await
        .unwrap();
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-11-06")
        .await
        .unwrap();
    let error = confirm(&w, &c, json!({"dismissal_notice":notice("2026-10-23")}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "dismissal_notice_short")
    );
    let detail = error.refusals.unwrap();
    assert!(
        detail[0]["required_days"].as_i64().unwrap() > detail[0]["notice_days"].as_i64().unwrap()
    );
    assert!(
        detail[0]["rule"]["article"]
            .as_str()
            .unwrap()
            .contains("제26조")
    );
    let out = confirm(&w, &c, json!({"dismissal_notice":notice("2026-10-23"),"notice_disposition":{"kind":"PAY_IN_LIEU"}}))
        .await.unwrap();
    assert_eq!(out["notice_disposition"]["kind"], "PAY_IN_LIEU");
    assert_eq!(out["notice_pay"]["owed"], true);
    assert_eq!(
        out["notice_pay"]["minimum_service_rule"]["release_disposition"],
        "HOLD"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn notice_days_are_recomputed_from_the_register(pool: PgPool) {
    let w = live(&pool).await;
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-11-06")
        .await
        .unwrap();
    let error = confirm(&w, &c, json!({"dismissal_notice":notice("2026-10-23")}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "dismissal_notice_short")
    );
    let actual_gap = error.refusals.unwrap()[0]["notice_days"].as_i64().unwrap();
    sqlx::query("UPDATE statutory_rules SET value_num=$1 WHERE code='DISMISSAL_NOTICE_DAYS' AND effective_from <= DATE '2026-11-06' AND (effective_to_exclusive IS NULL OR DATE '2026-11-06' < effective_to_exclusive)")
        .bind(actual_gap).execute(&pool).await.unwrap();
    let out = confirm(&w, &c, json!({"dismissal_notice":notice("2026-10-23")}))
        .await
        .unwrap();
    assert_eq!(out["notice_pay"]["required_days"], actual_gap);
    assert_eq!(out["notice_pay"]["owed"], false);
    assert!(out["notice_disposition"].is_null());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn minimum_service_months_are_recomputed_from_the_register(pool: PgPool) {
    let w = live(&pool).await;
    sqlx::query("UPDATE employees SET hire_date='2026-08-20' WHERE org_id=$1")
        .bind(w.org)
        .execute(&pool)
        .await
        .unwrap();
    let first = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-11-06")
        .await
        .unwrap();
    let out = confirm(&w, &first, json!({"dismissal_notice":notice("2026-10-23")}))
        .await
        .unwrap();
    assert_eq!(out["notice_pay"]["owed"], false);
    sqlx::query("UPDATE statutory_rules SET value_num=1 WHERE code='DISMISSAL_NOTICE_MIN_SERVICE_MONTHS' AND effective_from <= DATE '2026-11-06' AND (effective_to_exclusive IS NULL OR DATE '2026-11-06' < effective_to_exclusive)")
        .execute(&pool).await.unwrap();
    let second = report(&w, w.in_b, Some("DISCIPLINARY_DISMISSAL"), "2026-11-06")
        .await
        .unwrap();
    let error = confirm(
        &w,
        &second,
        json!({"dismissal_notice":notice("2026-10-23")}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "dismissal_notice_short")
    );
    assert_eq!(
        error.refusals.unwrap()[0]["minimum_service_rule"]["value"],
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn register_exception_requires_a_registered_ground_and_evidence(pool: PgPool) {
    let w = live(&pool).await;
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-11-06")
        .await
        .unwrap();
    for (ground, evidence) in [
        ("UNAVOIDABLE_CLOSURE", " "),
        ("UNKNOWN", "synthetic-evidence"),
    ] {
        let error = confirm(&w, &c, json!({"dismissal_notice":notice("2026-10-23"),"notice_disposition":{"kind":"REGISTER_EXCEPTION","ground_code":ground,"evidence_ref":evidence}}))
            .await.unwrap_err();
        assert_eq!(
            (error.status.as_u16(), error.code),
            (409, "dismissal_notice_short")
        );
    }
    let out = confirm(&w, &c, json!({"dismissal_notice":notice("2026-10-23"),"notice_disposition":{"kind":"REGISTER_EXCEPTION","ground_code":"UNAVOIDABLE_CLOSURE","evidence_ref":"synthetic-evidence"}}))
        .await.unwrap();
    assert_eq!(
        out["notice_disposition"]["ground_code"],
        "UNAVOIDABLE_CLOSURE"
    );
    assert_eq!(
        out["notice_disposition"]["evidence_ref"],
        "synthetic-evidence"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn scheduled_apply_rechecks_notice_days_and_preserves_a_pay_disposition(pool: PgPool) {
    let w = live(&pool).await;
    let today = (time::OffsetDateTime::now_utc() + Duration::hours(9)).date();
    let required: i64 = sqlx::query_scalar("SELECT value_num FROM statutory_rules WHERE code='DISMISSAL_NOTICE_DAYS' AND effective_from <= $1 AND (effective_to_exclusive IS NULL OR $1 < effective_to_exclusive)")
        .bind(today).fetch_one(&pool).await.unwrap();
    let on = today + Duration::days(required);
    let mut events = Vec::new();
    for (employee, disposition) in [
        (w.in_a, None),
        (w.in_b, Some(json!({"kind":"PAY_IN_LIEU"}))),
    ] {
        let c = report(
            &w,
            employee,
            Some("DISCIPLINARY_DISMISSAL"),
            &on.to_string(),
        )
        .await
        .unwrap();
        let mut body = json!({"dismissal_notice":notice(&today.to_string())});
        if let Some(disposition) = disposition {
            body["notice_disposition"] = disposition;
        }
        let out = confirm(&w, &c, body).await.unwrap();
        assert_eq!(out["exit_event_state"], "SCHEDULED");
        assert_eq!(out["notice_pay"]["owed"], false);
        events.push(
            out["exit_lifecycle_event_id"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
        );
    }
    sqlx::query("UPDATE statutory_rules SET value_num=$1 WHERE code='DISMISSAL_NOTICE_DAYS' AND effective_from <= $2 AND (effective_to_exclusive IS NULL OR $2 < effective_to_exclusive)")
        .bind(required + 1).bind(on).execute(&pool).await.unwrap();
    w.hr.apply_due(on.next_day().unwrap()).await.unwrap();
    for (event, expected) in events.iter().zip([
        (
            "APPLY_FAILED".to_owned(),
            Some("dismissal_notice_short".to_owned()),
        ),
        ("APPLIED".to_owned(), None),
    ]) {
        let actual: (String, Option<String>) =
            sqlx::query_as("SELECT state,failure_code FROM employee_lifecycle_events WHERE id=$1")
                .bind(event)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(actual, expected);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_new_hire_date_never_erases_the_prior_cases_notice_pay(pool: PgPool) {
    let w = live(&pool).await;
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-10-10")
        .await
        .unwrap();
    let out=confirm(&w,&c,json!({"dismissal_notice":notice("2026-10-01"),"notice_disposition":{"kind":"PAY_IN_LIEU"}})).await.unwrap();
    assert_eq!(out["notice_pay"]["owed"], true);
    sqlx::query("UPDATE employees SET hire_date='2027-01-01',exit_date=NULL,employment_status='ACTIVE' WHERE id=$1").bind(w.in_a).execute(&pool).await.unwrap();
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
    assert_eq!(
        serde_json::to_value(out).unwrap()["notice_pay"]["owed"],
        true
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sufficient_notice_still_rejects_an_unregistered_disposition(pool: PgPool) {
    let w = live(&pool).await;
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-11-06")
        .await
        .unwrap();
    let error=confirm(&w,&c,json!({"dismissal_notice":notice("2026-01-01"),"notice_disposition":{"kind":"REGISTER_EXCEPTION","ground_code":"UNKNOWN","evidence_ref":"synthetic"}})).await.unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "dismissal_notice_short")
    );
    confirm(&w, &c, json!({"dismissal_notice":notice("2026-01-01")}))
        .await
        .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_notice_basis_never_silently_accepts_pay_in_lieu(pool: PgPool) {
    let w = live(&pool).await;
    sqlx::query("DELETE FROM statutory_rules WHERE code='DISMISSAL_NOTICE_MIN_SERVICE_MONTHS'")
        .execute(&pool)
        .await
        .unwrap();
    let c = report(&w, w.in_a, Some("DISCIPLINARY_DISMISSAL"), "2026-11-06")
        .await
        .unwrap();
    let error=confirm(&w,&c,json!({"dismissal_notice":notice("2026-10-23"),"notice_disposition":{"kind":"PAY_IN_LIEU"}})).await.unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "dismissal_notice_short")
    );
    assert_eq!(
        error.refusals.unwrap()[0]["minimum_service_rule"]["release_disposition"],
        "UNKNOWN"
    );
}
