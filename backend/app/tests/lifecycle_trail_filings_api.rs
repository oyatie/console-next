// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Draft filing writes are refused through REST and cannot strand a workplace transfer.
#[path = "../../crates/hr/adapter-postgres/tests/support/lifecycle_attest.rs"]
mod attest;
#[path = "../../crates/hr/adapter-postgres/tests/emp_create/fixture.rs"]
#[allow(dead_code)]
mod fixture;
#[path = "support/http.rs"]
mod http;
use axum::http::StatusCode;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn draft_change_records_are_refused_and_the_appointment_closes(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let mut hire = f.body("http-change-filing", "REGULAR");
    let hired = console_hr_adapter_postgres::clock::today_kst() - time::Duration::days(1);
    hire.hire_date = Some(hired.to_string());
    let employee = f.create(hire).await.unwrap().employee_id();
    let (entity, from, to) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let org = *f.principal.org_id.as_uuid();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role=replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO legal_entities(org_id,id,needs_confirmation,created_change_mode) VALUES($1,$2,true,'MIGRATION')")
        .bind(org).bind(entity).execute(tx.as_mut()).await.unwrap();
    for workplace in [from, to] {
        sqlx::query("INSERT INTO workplaces(org_id,id,legal_entity_id,needs_confirmation,created_change_mode) VALUES($1,$2,$3,true,'MIGRATION')")
            .bind(org).bind(workplace).bind(entity).execute(tx.as_mut()).await.unwrap();
    }
    sqlx::query("INSERT INTO employment_assignments(org_id,employee_id,legal_entity_id,workplace_id,valid_from,cause,actor_id,command_id) VALUES($1,$2,$3,$4,$5::date,'HIRE',$6,gen_random_uuid())")
        .bind(org).bind(employee).bind(entity).bind(from).bind(hired.to_string()).bind(f.principal.user_id.as_uuid())
        .execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let ctx = http::ctx(&pool, org, f.principal.user_id, &["SUPER_ADMIN"], None).await;
    let (status,event)=ctx.call("POST",&format!("/api/v1/employees/{employee}/lifecycle-events"),Some(json!({
        "event_type":"TRANSFER","effective_date":http::today_kst().to_string(),"to_workplace_id":to,"comment":"사업장 발령"
    }))).await;
    assert_eq!(status, StatusCode::OK, "{event}");
    let event = event["id"].as_str().unwrap();
    let (status, page) = ctx
        .call(
            "GET",
            &format!("/api/v1/statutory/insurance-filings?event_id={event}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let filings = page["items"].as_array().unwrap();
    assert!(!filings.is_empty());
    for filing in filings {
        assert_eq!(filing["state"], "LEGAL_REVIEW");
        for body in [
            json!({"expected_version":0,"action":"COMPLETE","completed_on":http::today_kst().to_string()}),
            json!({"expected_version":0,"action":"NOT_APPLICABLE","not_applicable_reason":"OTHER_LEGAL_GROUND","detail":"검토 전"}),
            json!({"expected_version":0,"action":"ASSESS","applicability_facts":{}}),
        ] {
            let (status, problem) = ctx
                .call(
                    "POST",
                    &format!(
                        "/api/v1/statutory/insurance-filings/{event}/CHANGE/{}",
                        filing["insurer"].as_str().unwrap()
                    ),
                    Some(body),
                )
                .await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{problem}");
            assert_eq!(problem["error"]["code"], "filing_rule_unverified");
        }
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM insurance_filing_records WHERE event_id=$1::uuid")
            .bind(event)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let case = filings[0]["lifecycle_case_id"].as_str().unwrap();
    let dossier =
        f.hr.lifecycle_case(f.principal.clone(), Uuid::parse_str(case).unwrap())
            .await
            .unwrap();
    attest::document(&pool, &f.hr, &f.principal, &dossier).await;
    let (status, closed) = ctx
        .call(
            "POST",
            &format!("/api/v1/lifecycle-cases/{case}/close"),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{closed}");
    assert_eq!(closed["state"], "CLOSED");
}
