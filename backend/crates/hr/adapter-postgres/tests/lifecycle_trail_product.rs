// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Product completion and form-backed hire checklist observations.
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
use console_hr_adapter_postgres::{cases::CompleteItem, clock::today_kst};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use serde_json::json;
use sqlx::PgPool;
use time::Duration;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn typed_attestation_requires_a_bound_passkey_consumes_the_fact_and_closes_hire(
    pool: PgPool,
) {
    let f = fixture::fixture(pool.clone()).await;
    // rls-arming: ok owner fixture supplies the tenant's actual start of operations.
    sqlx::query("UPDATE tenant_phase SET phase='OPERATING',go_live_at=now(),go_live_by=$2,go_live_preview_digest=repeat('0',64) WHERE org_id=$1")
        .bind(f.principal.org_id.as_uuid()).bind(f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
    let mut hire = f.body("product-attestation", "REGULAR");
    hire.hire_date = Some((today_kst() - Duration::days(90)).to_string());
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
    let given = json!({"fact_date":today_kst().to_string(),"document":{"name":"입사 서류 확인서","url":"https://evidence.example/hire.pdf"},"reason_code":"OTHER","note":"서명한 입사 서류를 확인함"});
    let body = || {
        serde_json::from_value::<CompleteItem>(
            json!({"expected_version":item.version,"attestation":given}),
        )
        .unwrap()
    };
    let error =
        f.hr.complete_lifecycle_item(f.principal.clone(), case.id, item.id, body())
            .await
            .unwrap_err();
    assert_eq!(error.code, "step_up_required");
    let mut key = SoftKey::enroll(&pool, f.principal.org_id, f.principal.user_id).await;
    let payload = json!({"case_id":case.id,"item_id":item.id,"expected_version":item.version,"attestation":given});
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        item.id,
        console_hr_adapter_postgres::digest::sha256_hex(
            console_hr_adapter_postgres::exits::settlement::canonical_json(&payload)
                .to_string()
                .as_bytes(),
        ),
    );
    let service = passkey_service();
    let start = service
        .start_mobile_step_up(&pool, *f.principal.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":key.credential_id()}]);
    let envelope = json!({"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":key.assert(&challenge).unwrap()}});
    let mut changed = body();
    changed.attestation.as_mut().unwrap().document.url =
        "https://evidence.example/other.pdf".into();
    changed.step_up = Some(serde_json::from_value(envelope.clone()).unwrap());
    let error =
        f.hr.complete_lifecycle_item_with_passkeys(
            f.principal.clone(),
            case.id,
            item.id,
            changed,
            Some(&service),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "step_up_failed");
    let unrecorded: i64 =
        sqlx::query_scalar("SELECT count(*) FROM governed_exceptions WHERE subject_id=$1")
            .bind(item.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        unrecorded, 0,
        "a changed document must not mint or consume a fact"
    );
    let mut signed = body();
    signed.step_up = Some(serde_json::from_value(envelope).unwrap());
    let completed =
        f.hr.complete_lifecycle_item_with_passkeys(
            f.principal.clone(),
            case.id,
            item.id,
            signed,
            Some(&service),
        )
        .await
        .unwrap();
    let done = completed
        .items
        .iter()
        .find(|row| row.id == item.id)
        .unwrap();
    assert_eq!(done.status, "DONE_ATTESTED");
    assert_eq!(
        done.observed_ref.as_ref().unwrap()["document"]["name"],
        "입사 서류 확인서"
    );
    let consumed:bool=sqlx::query_scalar("SELECT consumed_at IS NOT NULL FROM governed_exceptions WHERE id=$1 AND subject_id=$2 AND rule_code='LIFECYCLE_ITEM_ATTESTED'")
        .bind(done.exception_id.unwrap()).bind(item.id).fetch_one(&pool).await.unwrap();
    assert!(consumed);
    assert_eq!(
        f.hr.close_lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap()
            .state,
        "CLOSED"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hire_fact_completion_observes_the_existing_facts_and_contract_rows(pool: PgPool) {
    let f = fixture::fixture(pool).await;
    let mut body = f.body("product-hire-facts", "REGULAR");
    body.hire_date = Some(today_kst().to_string());
    let employee = f.create(body).await.unwrap().employee_id();
    let case =
        f.hr.employee_lifecycle_cases(f.principal.clone(), employee)
            .await
            .unwrap()
            .remove(0);
    let birth = case
        .items
        .iter()
        .find(|item| item.label_key.as_deref() == Some("enum.checklistItem.BIRTH_DATE_RECORDED"))
        .unwrap();
    assert_eq!(birth.status, "OPEN");
    f.hr.patch_employment_facts(f.principal.clone(),employee,serde_json::from_value(json!([
        {"op":"test","path":"/birth_date","value":null},{"op":"replace","path":"/birth_date","value":"1990-05-01"}
    ])).unwrap()).await.unwrap();
    f.hr.record_contract(f.principal.clone(),employee,uuid::Uuid::new_v4(),serde_json::from_value(json!({"kind":"OPEN_ENDED","start_date":today_kst().to_string(),"wage_won":3000000,"pay_unit":"MONTHLY","weekly_minutes":2400})).unwrap()).await.unwrap();
    let updated =
        f.hr.lifecycle_case(f.principal.clone(), case.id)
            .await
            .unwrap();
    for (label, table) in [
        ("enum.checklistItem.BIRTH_DATE_RECORDED", "employees"),
        ("enum.checklistItem.CONTRACT_RECORDED", "employee_contracts"),
    ] {
        let item = updated
            .items
            .iter()
            .find(|item| item.label_key.as_deref() == Some(label))
            .unwrap();
        assert_eq!(item.status, "DONE_OBSERVED");
        assert_eq!(item.observed_ref.as_ref().unwrap()["table"], table);
        assert!(item.record_target.is_some());
    }
}
