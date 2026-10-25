// SPDX-License-Identifier: LicenseRef-Proprietary
//! Complete the document leg through the payload-bound passkey path before testing case closure.
use console_hr_adapter_postgres::{HrService, cases::LifecycleCase};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_authz::Principal;
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use serde_json::json;
use sqlx::PgPool;

pub async fn document(pool: &PgPool, hr: &HrService, p: &Principal, case: &LifecycleCase) {
    let item = case
        .items
        .iter()
        .find(|item| item.item_key == "D1")
        .unwrap();
    let today: String = sqlx::query_scalar("SELECT (now() AT TIME ZONE lifecycle_time_zone(org_id,employee_id,effective_date,workplace_id))::date::text FROM lifecycle_cases WHERE id=$1")
        .bind(case.id).fetch_one(pool).await.unwrap();
    let given = json!({"fact_date":today,"document":{"name":"발령 서류 확인서","url":"https://evidence.example/appointment.pdf"},"reason_code":"OTHER","note":"발령 서류 확인"});
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
    let mut key = SoftKey::enroll(pool, p.org_id, p.user_id).await;
    let service = passkey_service();
    let start = service
        .start_mobile_step_up(pool, *p.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":key.credential_id()}]);
    let completed = hr.complete_lifecycle_item_with_passkeys(p.clone(),case.id,item.id,
        serde_json::from_value(json!({"expected_version":item.version,"attestation":given,
            "step_up":{"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":key.assert(&challenge).unwrap()}}
        })).unwrap(),Some(&service)).await.unwrap();
    assert_eq!(
        completed
            .items
            .iter()
            .find(|row| row.id == item.id)
            .unwrap()
            .status,
        "DONE_ATTESTED"
    );
}
