// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A governed fact must already have happened in the case's local calendar.
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
use console_hr_adapter_postgres::clock::today_kst;
use serde_json::json;
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tomorrow_attestation_is_refused_without_changing_the_item_or_minting_a_fact(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut hire = f.body("future-attestation", "REGULAR");
    hire.hire_date = Some(today_kst().to_string());
    let employee = f.create(hire).await.unwrap().employee_id();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    let item = case
        .items
        .iter()
        .find(|item| item.item_key == "D1")
        .unwrap();
    let tomorrow: String = sqlx::query_scalar("SELECT ((now() AT TIME ZONE lifecycle_time_zone(org_id,employee_id,effective_date,workplace_id))::date+1)::text FROM lifecycle_cases WHERE id=$1")
        .bind(case.id).fetch_one(&pool).await.unwrap();
    let error = f.hr.complete_lifecycle_item(f.principal.clone(),case.id,item.id,serde_json::from_value(json!({
        "expected_version":item.version,"attestation":{"fact_date":tomorrow,
            "document":{"name":"입사 서류 확인서","url":"https://evidence.example/hire.pdf"},
            "reason_code":"OTHER","note":"입사 서류 확인"}
    })).unwrap()).await.unwrap_err();
    assert_eq!(error.code, "lifecycle.refuse.evidence_required");
    let after =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    let unchanged = after.items.iter().find(|row| row.id == item.id).unwrap();
    assert_eq!(
        serde_json::to_value(unchanged).unwrap(),
        serde_json::to_value(item).unwrap()
    );
    let minted: i64 = sqlx::query_scalar("SELECT count(*) FROM governed_exception_attestations a JOIN governed_exceptions e ON e.org_id=a.org_id AND e.id=a.exception_id WHERE e.subject_id=$1")
        .bind(item.id).fetch_one(&pool).await.unwrap();
    assert_eq!(minted, 0);
}
