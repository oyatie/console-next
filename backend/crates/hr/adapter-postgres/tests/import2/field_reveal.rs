// SPDX-License-Identifier: LicenseRef-Proprietary
//! The generic field path uses current stored facts and never reads before its access record commits.
use crate::rrn_governed::{key, loaded, proof};
use console_hr_adapter_postgres::rrn::{FieldRevealRequest, RevealField, reveal_binding};
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn contacts(pool: &PgPool, i: &crate::harness::Importer, id: Uuid) {
    let org = i.f.principal.org_id;
    let actor = i.f.principal.user_id;
    sqlx::query("INSERT INTO employee_employment_profiles(employee_id,org_id,employment_type,phone_e164,base_pay,idempotency_key,request_hash,created_by) VALUES($1,$2,'REGULAR','+821012345821',0,'privacy-profile',repeat('a',64),$3) ON CONFLICT(employee_id) DO UPDATE SET phone_e164=EXCLUDED.phone_e164")
        .bind(id).bind(org.as_uuid()).bind(actor.as_uuid()).execute(pool).await.unwrap();
    let address:Uuid=sqlx::query_scalar("INSERT INTO employee_addresses(org_id,employee_id,source,road_addr_part1,si_nm,sgg_nm,detail,created_by) VALUES($1,$2,'MANUAL_UNVERIFIED','경기도 평택시 새온로 118','경기도','평택시','101호',$3) RETURNING id")
        .bind(org.as_uuid()).bind(id).bind(actor.as_uuid()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO employee_register_facts(org_id,employee_id,address_id) VALUES($1,$2,$3) ON CONFLICT(org_id,employee_id) DO UPDATE SET address_id=EXCLUDED.address_id")
        .bind(org.as_uuid()).bind(id).bind(address).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO employee_personal_facts(org_id,employee_id,personal_email) VALUES($1,$2,'personal@example.com') ON CONFLICT(org_id,employee_id) DO UPDATE SET personal_email=EXCLUDED.personal_email")
        .bind(org.as_uuid()).bind(id).execute(pool).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_ordinary_field_uses_the_same_governed_path_and_redacted_access_record(pool: PgPool) {
    let (i, id) = loaded(pool.clone()).await;
    contacts(&pool, &i, id).await;
    let mut key = key(&pool, &i).await;
    for (field, expected) in [
        (RevealField::BirthDate, json!("1990-01-01")),
        (RevealField::Phone, json!("+821012345821")),
        (RevealField::PersonalEmail, json!("personal@example.com")),
        (RevealField::Address, json!(null)),
    ] {
        let proof = proof(
            &pool,
            &i,
            &mut key,
            reveal_binding(id, field.as_str(), "IDENTITY_VERIFICATION"),
        )
        .await;
        let request = FieldRevealRequest {
            field,
            reason_code: "IDENTITY_VERIFICATION".into(),
            note: None,
            step_up: Some(proof),
        };
        let result =
            i.f.hr
                .reveal_field(
                    i.f.principal.clone(),
                    id,
                    request,
                    None,
                    Some(&passkey_service()),
                )
                .await
                .unwrap();
        assert_eq!(result.field, field);
        assert_eq!(result.employee_id, id);
        if field == RevealField::Address {
            assert_eq!(result.value["detail"], "101호");
        } else {
            assert_eq!(result.value, expected);
        }
    }
    assert_eq!(
        i.count(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.field_reveal'"
        )
        .await,
        4
    );
    assert_eq!(i.count("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.field_reveal' AND (after_snap::text LIKE '%personal@example.com%' OR after_snap::text LIKE '%12345821%' OR after_snap::text LIKE '%101호%')").await,0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_value_is_read_after_the_log_commits_and_a_failed_log_returns_no_value(pool: PgPool) {
    let (i, id) = loaded(pool.clone()).await;
    contacts(&pool, &i, id).await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE FUNCTION synthetic_reveal_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_id='{id}' AND NEW.action='employee.field_reveal' THEN UPDATE employee_employment_profiles SET phone_e164='+821000009999' WHERE employee_id='{id}'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_reveal_order BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_reveal_order();"))).execute(&pool).await.unwrap();
    let mut key = key(&pool, &i).await;
    let request = FieldRevealRequest {
        field: RevealField::Phone,
        reason_code: "IDENTITY_VERIFICATION".into(),
        note: None,
        step_up: Some(
            proof(
                &pool,
                &i,
                &mut key,
                reveal_binding(id, "PHONE", "IDENTITY_VERIFICATION"),
            )
            .await,
        ),
    };
    let result =
        i.f.hr
            .reveal_field(
                i.f.principal.clone(),
                id,
                request,
                None,
                Some(&passkey_service()),
            )
            .await
            .unwrap();
    assert_eq!(
        result.value, "+821000009999",
        "a read made before the access record commits would return the old phone"
    );
    sqlx::raw_sql(sqlx::AssertSqlSafe("CREATE OR REPLACE FUNCTION synthetic_reveal_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='employee.field_reveal' THEN RAISE EXCEPTION 'synthetic access failure'; END IF; RETURN NEW; END $$;".to_owned())).execute(&pool).await.unwrap();
    let request = FieldRevealRequest {
        field: RevealField::BirthDate,
        reason_code: "IDENTITY_VERIFICATION".into(),
        note: None,
        step_up: Some(
            proof(
                &pool,
                &i,
                &mut key,
                reveal_binding(id, "BIRTH_DATE", "IDENTITY_VERIFICATION"),
            )
            .await,
        ),
    };
    assert!(
        i.f.hr
            .reveal_field(
                i.f.principal.clone(),
                id,
                request,
                None,
                Some(&passkey_service())
            )
            .await
            .is_err()
    );
    assert_eq!(
        i.count(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.field_reveal'"
        )
        .await,
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_generic_field_requires_step_up_and_a_missing_value_stays_unavailable(pool: PgPool) {
    let (i, id) = loaded(pool.clone()).await;
    let mut request: FieldRevealRequest =
        serde_json::from_value(json!({"field":"ADDRESS","reason_code":"IDENTITY_VERIFICATION"}))
            .unwrap();
    let result =
        i.f.hr
            .reveal_field(
                i.f.principal.clone(),
                id,
                request,
                None,
                Some(&passkey_service()),
            )
            .await
            .unwrap_err();
    assert_eq!(
        (result.status.as_u16(), result.code),
        (401, "step_up_required")
    );
    let mut key = key(&pool, &i).await;
    // Explicit null facts override the imported date and any legacy profile phone.
    sqlx::query("SELECT console_revise_person_facts($1, console_employee_person($1,$2), '{\"birth_date\":null,\"phone\":null}'::jsonb, $3)")
        .bind(i.f.principal.org_id.as_uuid()).bind(id).bind(i.f.principal.user_id.as_uuid())
        .execute(&pool).await.unwrap();
    for field in [
        RevealField::BirthDate,
        RevealField::Address,
        RevealField::Phone,
        RevealField::PersonalEmail,
    ] {
        request = FieldRevealRequest {
            field,
            reason_code: "IDENTITY_VERIFICATION".into(),
            note: None,
            step_up: Some(
                proof(
                    &pool,
                    &i,
                    &mut key,
                    reveal_binding(id, field.as_str(), "IDENTITY_VERIFICATION"),
                )
                .await,
            ),
        };
        assert_eq!(
            i.f.hr
                .reveal_field(
                    i.f.principal.clone(),
                    id,
                    request,
                    None,
                    Some(&passkey_service())
                )
                .await
                .unwrap_err()
                .status
                .as_u16(),
            404,
            "{field:?} has no stored value"
        );
        assert_eq!(
            i.count("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action IN ('employee.rrn_reveal','employee.field_reveal')").await,
            0,
            "a missing {field:?} must not record a reveal or consume the hourly budget"
        );
    }
}
