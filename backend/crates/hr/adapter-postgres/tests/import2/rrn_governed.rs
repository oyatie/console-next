// SPDX-License-Identifier: LicenseRef-Proprietary
//! SEC-01: a reveal refuses without a bound passkey, and commits its access record first.
use crate::harness::{Importer, MirrorVault, decisions, importer, table};
use console_hr_adapter_postgres::rrn::{RrnRevealRequest, reveal_binding};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope};
use console_platform_test_support::soft_passkey::{SoftKey, passkey_service};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

pub(super) async fn loaded(pool: PgPool) -> (Importer, Uuid) {
    let i = importer(pool).await;
    i.load(
        "privacy.xlsx",
        &[table(
            "명부",
            0,
            &[
                &["사번", "성명", "주민등록번호", "생년월일", "입사일"],
                &["1001", "김가", "900101-1234567", "1990-01-01", "2024-01-02"],
            ],
        )],
        decisions(),
    )
    .await;
    let (id, _, _) = i.person("김가").await;
    (i, id)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_reveal_without_step_up_is_refused(pool: PgPool) {
    let (i, id) = loaded(pool).await;
    let request: RrnRevealRequest =
        serde_json::from_value(json!({"reason_code":"IDENTITY_VERIFICATION"})).unwrap();
    let error =
        i.f.hr
            .rrn_reveal(
                i.f.principal.clone(),
                id,
                request,
                Some(&MirrorVault),
                Some(&passkey_service()),
            )
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (401, "step_up_required")
    );
}

pub(super) async fn proof(
    pool: &PgPool,
    i: &Importer,
    key: &mut SoftKey,
    binding: MobilePasskeyStepUpBinding,
) -> MobilePasskeyStepUpEnvelope {
    let start = passkey_service()
        .start_mobile_step_up(pool, *i.f.principal.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{ "type":"public-key", "id":key.credential_id() }]);
    MobilePasskeyStepUpEnvelope {
        binding,
        assertion: console_platform_auth::MobilePasskeyStepUpAssertion {
            ceremony_id: start.ceremony_id,
            credential: serde_json::from_value(key.assert(&challenge).unwrap()).unwrap(),
        },
    }
}

pub(super) async fn key(pool: &PgPool, i: &Importer) -> SoftKey {
    SoftKey::enroll(pool, i.f.principal.org_id, i.f.principal.user_id).await
}

pub(super) fn request(proof: MobilePasskeyStepUpEnvelope) -> RrnRevealRequest {
    RrnRevealRequest {
        reason_code: "IDENTITY_VERIFICATION".into(),
        note: None,
        step_up: Some(proof),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn proof_cannot_be_used_for_another_employee_field_reason_or_stale_ceremony(pool: PgPool) {
    let (i, id) = loaded(pool.clone()).await;
    let mut key = key(&pool, &i).await;
    for binding in [
        reveal_binding(Uuid::new_v4(), "RRN", "IDENTITY_VERIFICATION"),
        reveal_binding(id, "PHONE", "IDENTITY_VERIFICATION"),
        reveal_binding(id, "RRN", "OTHER"),
    ] {
        let body = request(proof(&pool, &i, &mut key, binding).await);
        let error =
            i.f.hr
                .rrn_reveal(
                    i.f.principal.clone(),
                    id,
                    body,
                    Some(&MirrorVault),
                    Some(&passkey_service()),
                )
                .await
                .unwrap_err();
        assert_eq!(
            (error.status.as_u16(), error.code),
            (401, "passkey_step_up_failed")
        );
    }
    let body = request(
        proof(
            &pool,
            &i,
            &mut key,
            reveal_binding(id, "RRN", "IDENTITY_VERIFICATION"),
        )
        .await,
    );
    sqlx::query("UPDATE auth_webauthn_ceremony_bindings SET created_at=now()-interval '6 minutes' WHERE ceremony_id=$1")
        .bind(body.step_up.as_ref().unwrap().assertion.ceremony_id).execute(&pool).await.unwrap();
    let error =
        i.f.hr
            .rrn_reveal(
                i.f.principal.clone(),
                id,
                body,
                Some(&MirrorVault),
                Some(&passkey_service()),
            )
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (401, "passkey_step_up_failed")
    );
    assert_eq!(
        i.count(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.rrn_reveal'"
        )
        .await,
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reveal_needs_directory_permission_and_subject_reach(pool: PgPool) {
    let (i, id) = loaded(pool).await;
    let mut no = i.f.principal.clone();
    no.roles = std::collections::BTreeSet::from([console_platform_authz::Role::Member]);
    let body = || serde_json::from_value(json!({"reason_code":"IDENTITY_VERIFICATION"})).unwrap();
    let error =
        i.f.hr
            .rrn_reveal(no, id, body(), Some(&MirrorVault), Some(&passkey_service()))
            .await
            .unwrap_err();
    assert_eq!(error.status.as_u16(), 403);
    let mut no = i.f.principal.clone();
    no.branch_scope =
        console_kernel_core::BranchScope::Branches(std::collections::BTreeSet::from([
            console_kernel_core::BranchId::new(),
        ]));
    let error =
        i.f.hr
            .rrn_reveal(no, id, body(), Some(&MirrorVault), Some(&passkey_service()))
            .await
            .unwrap_err();
    assert_eq!(error.status.as_u16(), 403);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_purposes_and_other_without_note_stay_closed(pool: PgPool) {
    let (i, id) = loaded(pool.clone()).await;
    let mut key = key(&pool, &i).await;
    for reason in ["NOT_A_CODE", "OTHER"] {
        let mut body = request(proof(&pool, &i, &mut key, reveal_binding(id, "RRN", reason)).await);
        body.reason_code = reason.into();
        let error =
            i.f.hr
                .rrn_reveal(
                    i.f.principal.clone(),
                    id,
                    body,
                    Some(&MirrorVault),
                    Some(&passkey_service()),
                )
                .await
                .unwrap_err();
        assert_eq!(error.status.as_u16(), 422);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn no_record_and_no_vault_never_return_a_number(pool: PgPool) {
    let (i, id) = loaded(pool.clone()).await;
    let mut key = key(&pool, &i).await;
    let body = request(
        proof(
            &pool,
            &i,
            &mut key,
            reveal_binding(id, "RRN", "IDENTITY_VERIFICATION"),
        )
        .await,
    );
    let error =
        i.f.hr
            .rrn_reveal(
                i.f.principal.clone(),
                id,
                body,
                None,
                Some(&passkey_service()),
            )
            .await
            .unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (503, "rrn_vault_unavailable")
    );
    assert_eq!(
        i.count("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action IN ('employee.rrn_reveal','employee.field_reveal')").await,
        0,
        "an unavailable vault must not record a reveal or consume the hourly budget"
    );
    sqlx::query("DELETE FROM employee_rrn WHERE employee_id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let body = request(
        proof(
            &pool,
            &i,
            &mut key,
            reveal_binding(id, "RRN", "IDENTITY_VERIFICATION"),
        )
        .await,
    );
    let error =
        i.f.hr
            .rrn_reveal(
                i.f.principal.clone(),
                id,
                body,
                Some(&MirrorVault),
                Some(&passkey_service()),
            )
            .await
            .unwrap_err();
    assert_eq!(error.status.as_u16(), 404);
    assert_eq!(
        i.count("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action IN ('employee.rrn_reveal','employee.field_reveal')").await,
        0,
        "a missing RRN must not record a reveal or consume the hourly budget"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_ceiling_refuses_limit_plus_one_and_the_duration_comes_from_settings(pool: PgPool) {
    let (i, id) = loaded(pool.clone()).await;
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'privacy.reveal_rate_per_hour','5',$2,'TEST'),($1,'privacy.reveal_display_seconds','15',$2,'TEST')").bind(i.f.principal.org_id.as_uuid()).bind(i.f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
    let mut key = key(&pool, &i).await;
    for n in 0..6 {
        let body = request(
            proof(
                &pool,
                &i,
                &mut key,
                reveal_binding(id, "RRN", "IDENTITY_VERIFICATION"),
            )
            .await,
        );
        let result =
            i.f.hr
                .rrn_reveal(
                    i.f.principal.clone(),
                    id,
                    body,
                    Some(&MirrorVault),
                    Some(&passkey_service()),
                )
                .await;
        if n < 5 {
            let shown = result.unwrap();
            assert_eq!(shown.display_seconds, 15);
            assert_eq!(shown.rrn, "900101-1234567");
        } else {
            let error = result.unwrap_err();
            assert_eq!(
                (error.status.as_u16(), error.code),
                (429, "reveal_rate_limited")
            );
        }
    }
    assert_eq!(
        i.count(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.rrn_reveal'"
        )
        .await,
        5
    );
    assert_eq!(
        i.count(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND after_snap::text LIKE '%234567%'"
        )
        .await,
        0
    );
}
