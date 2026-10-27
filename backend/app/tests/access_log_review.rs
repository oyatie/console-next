// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "../../crates/hr/adapter-postgres/tests/emp_record/fixture.rs"]
mod fixture;

use console_hr_adapter_postgres::{
    record::RecordPurpose,
    rrn::{FieldRevealRequest, RevealField, reveal_binding},
};
use console_hr_domain::{
    import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError},
    record::Section,
};
use console_platform_access::log_review::SENSITIVE_READS;
use console_platform_auth::{MobilePasskeyStepUpAssertion, MobilePasskeyStepUpEnvelope};
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

struct TestVault;
impl RrnVault for TestVault {
    fn seal(&self, _: Uuid, _: &Rrn) -> Result<SealedRrn, VaultError> {
        Err(VaultError)
    }
    fn blind_index(&self, _: &Rrn) -> Vec<u8> {
        vec![0; 32]
    }
    fn open(&self, _: Uuid, _: &SealedRrn) -> Result<Rrn, VaultError> {
        Rrn::parse("900101-1234567").map_err(|_| VaultError)
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sensitive_catalog_matches_each_real_writer_on_the_runtime_role(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let employee = f.employee("review-sensitive").await;
    sqlx::query("UPDATE employees SET birth_date='1990-01-01' WHERE id=$1")
        .bind(employee)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO employee_rrn(org_id,employee_id,rrn_hmac,hmac_key_version,ciphertext,nonce,dek_wrapped,dek_nonce,key_version,masked,source,recorded_by) VALUES ($1,$2,decode(repeat('00',32),'hex'),1,decode(repeat('00',24),'hex'),decode(repeat('00',24),'hex'),decode(repeat('00',16),'hex'),decode(repeat('00',24),'hex'),1,'900101-1******','FORM',$3)")
        .bind(f.org).bind(employee).bind(f.user).execute(&pool).await.unwrap();
    let p = f.principal.clone();
    let mut key =
        console_platform_test_support::soft_passkey::SoftKey::enroll(&pool, p.org_id, p.user_id)
            .await;
    for field in [RevealField::Rrn, RevealField::BirthDate] {
        let binding = reveal_binding(employee, field.as_str(), "IDENTITY_VERIFICATION");
        let service = passkey_service();
        let start = service
            .start_mobile_step_up(&pool, f.user, binding.clone())
            .await
            .unwrap();
        let mut challenge = serde_json::to_value(start.challenge).unwrap();
        challenge["publicKey"]["allowCredentials"] =
            json!([{ "type":"public-key", "id":key.credential_id() }]);
        let step_up = MobilePasskeyStepUpEnvelope {
            binding,
            assertion: MobilePasskeyStepUpAssertion {
                ceremony_id: start.ceremony_id,
                credential: serde_json::from_value(key.assert(&challenge).unwrap()).unwrap(),
            },
        };
        f.hr.reveal_field(
            p.clone(),
            employee,
            FieldRevealRequest {
                field,
                reason_code: "IDENTITY_VERIFICATION".into(),
                note: None,
                step_up: Some(step_up),
            },
            Some(&TestVault),
            Some(&service),
        )
        .await
        .unwrap();
    }
    f.hr.employee_records(
        p,
        employee,
        Some(Section::Discipline),
        false,
        Some(RecordPurpose {
            code: "DISCIPLINARY_PROCEDURE".into(),
            note: None,
        }),
    )
    .await
    .unwrap();
    let rows:Vec<(String,Value)> = sqlx::query_as("SELECT action,after_snap FROM audit_events WHERE org_id=$1 AND action=ANY($2) ORDER BY action")
        .bind(f.org).bind(SENSITIVE_READS).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), SENSITIVE_READS.len());
    for (action, detail) in rows {
        assert_eq!(
            detail["self_read"], false,
            "{action} must reach the access review's row predicate"
        );
        assert_eq!(detail["subject_count"], 1, "{action}");
        assert_eq!(detail["subject_ids"], json!([employee]), "{action}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn review_policy_resolves_on_the_runtime_role_and_sql_enforces_its_bounds(pool: PgPool) {
    use console_kernel_core::OrgId;
    use console_platform_db::{DbError, with_org_conn};
    use console_settings_domain::{SettingError, SettingKey};
    let org = OrgId::new();
    let user = console_platform_test_support::seed_org_and_super_admin(
        &pool,
        *org.as_uuid(),
        "review-policy",
    )
    .await;
    let rt = console_platform_test_support::runtime_role_pool(&pool).await;
    let keys: Vec<_> = SettingKey::ALL
        .iter()
        .copied()
        .filter(|key| key.as_str().starts_with("access_log_review."))
        .collect();
    assert_eq!(keys.len(), 11);
    let resolved =
        with_org_conn::<_, _, console_platform_access::AccessError>(&rt, org, |tx| {
            Box::pin(async move {
                let now = sqlx::query_scalar("SELECT now()")
                    .fetch_one(tx.as_mut())
                    .await?;
                Ok(console_settings_adapter_postgres::resolve_in_tx(
                    tx.as_mut(),
                    org,
                    &keys,
                    None,
                    now,
                )
                .await?)
            })
        })
        .await
        .unwrap();
    for (key, value) in resolved {
        match key.def().default {
            Some(default) => assert_eq!(value.unwrap().value, default),
            None => assert_eq!(value.unwrap_err(), SettingError::FactUndeclared(key)),
        }
    }
    for key in [
        "access_log_review.cadence_months",
        "access_log_review.flag.bulk_subjects_min",
        "access_log_review.flag.denied_min",
    ] {
        let result = with_org_conn::<_, _, DbError>(&rt,org,move |tx| Box::pin(async move {
            sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,$2,'0'::jsonb,$3,'POLICY_REVIEW')")
                .bind(org.as_uuid()).bind(key).bind(user.as_uuid()).execute(tx.as_mut()).await?;
            Ok(())
        })).await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("setting_out_of_range"),
            "{key}"
        );
    }
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM tenant_setting_overrides WHERE org_id=$1")
            .bind(org.as_uuid())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rows, 0);
}
