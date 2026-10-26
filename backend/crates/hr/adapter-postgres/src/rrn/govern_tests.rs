// SPDX-License-Identifier: LicenseRef-Proprietary
//! Exercise the transaction gate itself so a bypassed Cedar denial cannot hide behind another gate.
#![allow(clippy::unwrap_used)]

use super::*;
use crate::rrn::{FieldRevealRequest, RevealField};
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{
    Feature, Role,
    access::{NodeKind, ScopeGrant},
};
use console_platform_test_support::{
    runtime_role_pool, seed_org_and_super_admin,
    soft_passkey::{SoftKey, passkey_service},
};
use serde_json::json;
use sqlx::PgPool;
use std::collections::BTreeSet;

struct Fixture {
    principal: Principal,
    employee: Uuid,
    unit: Uuid,
    key: SoftKey,
}

async fn fixture(pool: &PgPool) -> Fixture {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(pool, *org.as_uuid(), "pii-cedar").await;
    let unit = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units(org_id,id) VALUES($1,$2)")
        .bind(org.as_uuid())
        .bind(unit)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions(org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES($1,$2,1,gen_random_uuid(),$3,sha256('test'::bytea),'{\"name\":\"Department\",\"kind\":\"department\"}','{}')")
        .bind(org.as_uuid()).bind(unit).bind(user.as_uuid()).execute(pool).await.unwrap();
    let employee = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,org_unit_id,source_filename,source_sheet,source_row,source_key) VALUES($1,'Test','Test subject',$2,'test.xlsx','Sheet',1,'pii-cedar') RETURNING id")
        .bind(org.as_uuid()).bind(unit).fetch_one(pool).await.unwrap();
    Fixture {
        principal: Principal::new(
            user,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        ),
        employee,
        unit,
        key: SoftKey::enroll(pool, org, user).await,
    }
}

async fn request(pool: &PgPool, f: &mut Fixture, reason: &str) -> FieldRevealRequest {
    let binding = reveal_binding(f.employee, "RRN", reason);
    let start = passkey_service()
        .start_mobile_step_up(pool, *f.principal.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{ "type":"public-key", "id":f.key.credential_id() }]);
    FieldRevealRequest {
        field: RevealField::Rrn,
        reason_code: reason.into(),
        note: None,
        step_up: Some(MobilePasskeyStepUpEnvelope {
            binding,
            assertion: console_platform_auth::MobilePasskeyStepUpAssertion {
                ceremony_id: start.ceremony_id,
                credential: serde_json::from_value(f.key.assert(&challenge).unwrap()).unwrap(),
            },
        }),
    }
}

async fn gate(pool: &PgPool, f: &Fixture, request: FieldRevealRequest) -> Result<i64, HrError> {
    let rt = runtime_role_pool(pool).await;
    let mut tx = rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let result = authorize(
        &mut tx,
        &f.principal,
        f.employee,
        request,
        Some(&passkey_service()),
    )
    .await;
    tx.rollback().await.unwrap();
    result
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_denies_without_a_directory_grant(pool: PgPool) {
    let mut f = fixture(&pool).await;
    f.principal.roles = BTreeSet::from([Role::Member]);
    let body = request(&pool, &mut f, "IDENTITY_VERIFICATION").await;
    assert_eq!(
        gate(&pool, &f, body).await.unwrap_err().status.as_u16(),
        403
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_denies_a_subject_outside_the_granted_scope(pool: PgPool) {
    let mut f = fixture(&pool).await;
    f.principal.roles = BTreeSet::from([Role::Member]);
    for kind in [
        NodeKind::LegalEntity,
        NodeKind::Workplace,
        NodeKind::Department,
    ] {
        f.principal.scope_grants = vec![ScopeGrant {
            feature: Feature::EmployeeDirectoryManage,
            kind,
            id: Uuid::new_v4(),
        }];
        let body = request(&pool, &mut f, "IDENTITY_VERIFICATION").await;
        let error = gate(&pool, &f, body).await.unwrap_err();
        assert_eq!((error.status.as_u16(), error.code), (403, "out_of_scope"));
    }
    f.principal.scope_grants[0].id = f.unit;
    let body = request(&pool, &mut f, "IDENTITY_VERIFICATION").await;
    assert!(
        gate(&pool, &f, body).await.is_ok(),
        "a grant over the subject's department must work"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_denies_a_passkey_assertion_older_than_five_minutes(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let body = request(&pool, &mut f, "IDENTITY_VERIFICATION").await;
    sqlx::query("UPDATE auth_webauthn_ceremony_bindings SET created_at=now()-interval '5 minutes 1 second' WHERE ceremony_id=$1")
        .bind(body.step_up.as_ref().unwrap().assertion.ceremony_id).execute(&pool).await.unwrap();
    let error = gate(&pool, &f, body).await.unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (401, "passkey_step_up_failed")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn cedar_denies_a_missing_reason(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let body = request(&pool, &mut f, "").await;
    let error = gate(&pool, &f, body).await.unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (422, "reason_code_invalid")
    );
}
