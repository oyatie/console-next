// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn renewal_picker_only_offers_registered_exceptions_bound_to_the_chosen_end(pool: PgPool) {
    let (c, id, _, _) = fixture(&pool).await;
    let employee: Uuid = id.parse().unwrap();
    let org: Uuid = sqlx::query_scalar("SELECT org_id FROM employees WHERE id=$1")
        .bind(employee)
        .fetch_one(&pool)
        .await
        .unwrap();
    let user: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE org_id=$1 LIMIT 1")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    let exception: Uuid = sqlx::query_scalar("INSERT INTO governed_exceptions (org_id, rule_code, risk, subject_type, subject_id, reason_code, fingerprint, settings_snapshot, requested_by, step_up_assertion_id, status, fallback_kind, review_due_at, expires_at) VALUES ($1,'FIXED_TERM_OVER_TWO_YEARS','HIGH','EMPLOYEE',$2,'OLDER_WORKER',governed_exception_fingerprint($3,'{}'::daterange[]),'{}',$4,$5,'RECORDED','SOLE_HOLDER',now()+interval '1 day',now()+interval '1 day') RETURNING id")
        .bind(org).bind(employee).bind(json!({"employee_id":employee,"contract_end_date":"2027-12-31"})).bind(user).bind(Uuid::new_v4()).fetch_one(&pool).await.unwrap();
    let path = format!("/api/v1/employees/{id}/fixed-term");
    let (s, wrong) = c
        .call("GET", &format!("{path}?contract_end_date=2028-12-31"), None)
        .await;
    assert_eq!(s, StatusCode::OK, "{wrong}");
    assert_eq!(wrong["available_exceptions"], json!([]));
    let (s, matching) = c
        .call("GET", &format!("{path}?contract_end_date=2027-12-31"), None)
        .await;
    assert_eq!(s, StatusCode::OK, "{matching}");
    assert_eq!(
        matching["available_exceptions"][0]["id"],
        exception.to_string()
    );
    assert_eq!(
        matching["available_exceptions"][0]["ground_code"],
        "OLDER_WORKER"
    );
    assert!(
        matching["available_exceptions"][0]["basis"]
            .as_str()
            .unwrap()
            .contains("제4조제1항제4호")
    );
    let (s, _) = c
        .call("GET", &format!("{path}?contract_end_date=invalid"), None)
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
}
