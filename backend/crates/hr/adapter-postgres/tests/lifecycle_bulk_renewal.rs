// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/lifecycle_grant.rs"]
mod lifecycle_grant;

use console_hr_adapter_postgres::clock::today_kst;
use serde_json::json;
use sqlx::PgPool;
use time::{Date, Duration};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn public_bulk_renewal_refuses_an_invalid_window_then_records_the_extended_contract(
    pool: PgPool,
) {
    let today = today_kst();
    let f = fixture::fixture(pool.clone()).await;
    lifecycle_grant::grant(
        &pool,
        *f.principal.org_id.as_uuid(),
        *f.principal.user_id.as_uuid(),
    )
    .await;
    let end = today + Duration::days(90);
    let mut body = f.body("contract-renewal", "CONTRACT");
    body.hire_date = Some(today.to_string());
    body.contract_start_date = Some(today.to_string());
    body.contract_end_date = Some(end.to_string());
    let employee = f
        .create(body)
        .await
        .expect("a fixed-term head is registered")
        .employee_id();
    let renew = |until: Date| {
        json!({"event_type":"CONTRACT_RENEWAL","employee_ids":[employee],
        "effective_date":today.to_string(),"contract_end_date":until.to_string(),"comment":"계약 갱신"})
    };
    let invalid = renew(today + Duration::days(1_000));
    let preview =
        f.hr.preview_bulk_lifecycle_events(
            f.principal.clone(),
            serde_json::from_value(invalid.clone()).unwrap(),
        )
        .await
        .expect("preview reports a per-person refusal");
    assert_eq!(
        preview.refusals.len(),
        1,
        "a renewal past the fixed-term limit must be refused per person"
    );
    assert_eq!(preview.refusals[0]["employee_id"], json!(employee));
    assert_eq!(preview.refusals[0]["code"], "fixed_term_limit");
    let error =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(invalid).unwrap(),
        )
        .await
        .expect_err("commit must refuse the same invalid window");
    assert_eq!(
        (error.status.as_u16(), error.code),
        (422, "bulk_lifecycle_refused")
    );
    assert_eq!(*error.refusals.unwrap(), json!(preview.refusals));
    let unchanged: Date = sqlx::query_scalar(
        "SELECT contract_end_date FROM employee_employment_profiles WHERE employee_id=$1",
    )
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        unchanged, end,
        "refusal leaves the original contract intact"
    );

    let extended = end + Duration::days(30);
    let request = renew(extended);
    let preview =
        f.hr.preview_bulk_lifecycle_events(
            f.principal.clone(),
            serde_json::from_value(request.clone()).unwrap(),
        )
        .await
        .expect("a valid extension is admitted by preview");
    assert!(preview.refusals.is_empty());
    assert_eq!(preview.counts.will_apply, 1);
    let done =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            Uuid::new_v4().to_string(),
            serde_json::from_value(request).unwrap(),
        )
        .await
        .expect("a valid extension commits through the public bulk service");
    assert_eq!(done["items"][0]["state"], "APPLIED");
    assert_eq!(done["items"][0]["contract_end_date"], extended.to_string());
    let saved: (Date, Date) = sqlx::query_as("SELECT from_contract_end_date,contract_end_date FROM employee_lifecycle_events WHERE employee_id=$1 AND event_type='CONTRACT_RENEWAL'")
        .bind(employee).fetch_one(&pool).await.unwrap();
    assert_eq!(
        saved,
        (end, extended),
        "the receipt preserves the old end and the extension"
    );
    let actual: Date = sqlx::query_scalar(
        "SELECT contract_end_date FROM employee_employment_profiles WHERE employee_id=$1",
    )
    .bind(employee)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(actual, extended);
}
