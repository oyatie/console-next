// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Future-dated governed evidence is refused at the deployed REST boundary.
#[path = "../../crates/hr/adapter-postgres/tests/emp_create/fixture.rs"]
#[allow(dead_code)]
mod fixture;
#[path = "support/http.rs"]
mod http;
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tomorrow_attestation_is_refused_without_changing_the_item_or_minting_a_fact(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut hire = f.body("http-future-attestation", "REGULAR");
    hire.hire_date = Some(http::today_kst().to_string());
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
    let ctx = http::ctx(
        &pool,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &["SUPER_ADMIN"],
        None,
    )
    .await;
    let (status,problem) = ctx.call("POST",&format!("/api/v1/lifecycle-cases/{}/items/{}/complete",case.id,item.id),Some(json!({
        "expected_version":item.version,"attestation":{"fact_date":tomorrow,
            "document":{"name":"입사 서류 확인서","url":"https://evidence.example/hire.pdf"},
            "reason_code":"OTHER","note":"입사 서류 확인"}
    }))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        problem["error"]["code"],
        "lifecycle.refuse.evidence_required"
    );
    assert_eq!(problem["type"], "about:blank");
    let unchanged: (String, Option<Value>, Option<uuid::Uuid>, i64) = sqlx::query_as(
        "SELECT status,observed_ref,exception_id,version FROM lifecycle_case_items WHERE id=$1",
    )
    .bind(item.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unchanged, (item.status.clone(), None, None, item.version));
    let minted: i64 = sqlx::query_scalar("SELECT count(*) FROM governed_exception_attestations a JOIN governed_exceptions e ON e.org_id=a.org_id AND e.id=a.exception_id WHERE e.subject_id=$1")
        .bind(item.id).fetch_one(&pool).await.unwrap();
    assert_eq!(minted, 0);
}
