// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The real record route: refusal codes, durable audit before sealing, and concurrent conflicts.
use axum::{
    Extension, Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_hr_adapter_postgres::HrService;
use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
use console_hr_rest::identity::router;
use console_kernel_core::{BranchScope, OrgId};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind};
use console_platform_authz::{Principal, Role};
use console_platform_test_support::{
    runtime_role_pool, seed_active_user, seed_org_and_super_admin,
    soft_passkey::{SoftKey, passkey_service},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;
use uuid::Uuid;

#[derive(Default)]
struct Vault(AtomicUsize);
impl RrnVault for Vault {
    fn seal(&self, _: Uuid, r: &Rrn) -> Result<SealedRrn, VaultError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(SealedRrn {
            hmac: self.blind_index(r),
            hmac_key_version: 1,
            ciphertext: vec![0; 16],
            nonce: vec![0; 24],
            dek_wrapped: vec![0; 16],
            dek_nonce: vec![0; 24],
            key_version: 1,
            masked: r.masked(),
        })
    }
    fn blind_index(&self, r: &Rrn) -> Vec<u8> {
        r.digits().bytes().cycle().take(32).collect()
    }
    fn open(&self, _: Uuid, _: &SealedRrn) -> Result<Rrn, VaultError> {
        Err(VaultError)
    }
}
struct Fixture {
    hr: HrService,
    principal: Principal,
    ids: [Uuid; 2],
    key: SoftKey,
    vault: Arc<Vault>,
}
async fn fixture(pool: &PgPool) -> Fixture {
    let org = OrgId::new();
    let user = seed_org_and_super_admin(pool, *org.as_uuid(), "rrn-record").await;
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(user.as_uuid())
        .execute(pool)
        .await
        .unwrap();
    let ids = [Uuid::new_v4(), Uuid::new_v4()];
    for id in ids {
        sqlx::query("INSERT INTO employees(org_id,id,company,name,source_filename,source_sheet,source_row,source_key) VALUES($1,$2,'Test','Subject','synthetic','Sheet',1,$2::text)")
            .bind(org.as_uuid()).bind(id).execute(pool).await.unwrap();
    }
    Fixture {
        hr: HrService::new(runtime_role_pool(pool).await),
        principal: Principal::new(
            user,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        ),
        ids,
        key: SoftKey::enroll(pool, org, user).await,
        vault: Arc::new(Vault::default()),
    }
}
async fn body(pool: &PgPool, f: &mut Fixture, id: Uuid) -> Value {
    // SHA-256 of the public id, using the same primitive as the web client.
    let hash: String = sqlx::query_scalar("SELECT encode(sha256($1::bytea),'hex')")
        .bind(id.to_string().as_bytes())
        .fetch_one(pool)
        .await
        .unwrap();
    let binding = MobilePasskeyStepUpBinding::bound(MobileStepUpActionKind::PiiRecord, id, hash);
    let start = passkey_service()
        .start_mobile_step_up(pool, *f.principal.user_id.as_uuid(), binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        json!([{"type":"public-key","id":f.key.credential_id()}]);
    json!({"rrn":"9001011234567","step_up":{"binding":binding,"assertion":{"ceremony_id":start.ceremony_id,"credential":f.key.assert(&challenge).unwrap()}}})
}
fn app(f: &Fixture, vault: bool) -> Router {
    router(
        f.hr.clone(),
        vault.then(|| f.vault.clone() as Arc<dyn RrnVault>),
        Some(passkey_service()),
    )
    .layer(Extension(f.principal.clone()))
}
async fn put(app: Router, id: Uuid, body: Value) -> (StatusCode, Value) {
    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/api/v1/employees/{id}/rrn"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("234567"));
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn refusal(app: Router, id: Uuid, body: Value, status: u16, code: &str) {
    let (actual, value) = put(app, id, body).await;
    assert_eq!(actual.as_u16(), status);
    assert_eq!(value["error"]["code"], code);
    assert_eq!(value["error"].as_object().unwrap().len(), 2);
    assert!(value["error"]["message"].is_string());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn put_requires_step_up(pool: PgPool) {
    let f = fixture(&pool).await;
    refusal(
        app(&f, true),
        f.ids[0],
        json!({"rrn":"9001011234567"}),
        401,
        "step_up_required",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn malformed_payload_does_not_echo_the_number(pool: PgPool) {
    let f = fixture(&pool).await;
    refusal(
        app(&f, true),
        f.ids[0],
        json!({"rrn":9001011234567_i64}),
        422,
        "rrn_invalid",
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn refuses_missing_permission_invalid_proof_invalid_rrn_and_missing_vault(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let [id, other] = f.ids;
    let wrong = body(&pool, &mut f, other).await;
    refusal(app(&f, true), id, wrong, 401, "passkey_step_up_failed").await;
    let mut invalid = body(&pool, &mut f, id).await;
    invalid["rrn"] = json!("invalid");
    refusal(app(&f, true), id, invalid, 422, "rrn_invalid").await;
    let valid = body(&pool, &mut f, id).await;
    refusal(app(&f, false), id, valid, 503, "rrn_vault_unavailable").await;
    let member = seed_active_user(
        &pool,
        *f.principal.org_id.as_uuid(),
        "MEMBER",
        "record-refusal",
    )
    .await;
    f.principal.user_id = member;
    f.principal.roles = BTreeSet::from([Role::Member]);
    f.key = SoftKey::enroll(&pool, f.principal.org_id, member).await;
    let valid = body(&pool, &mut f, id).await;
    refusal(app(&f, true), id, valid, 403, "forbidden").await;
    assert_eq!(f.vault.0.load(Ordering::SeqCst), 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn records_form_metadata_masks_response_and_refuses_both_conflicts(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let [id, other] = f.ids;
    let valid = body(&pool, &mut f, id).await;
    let ceremony = valid["step_up"]["assertion"]["ceremony_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let expected: String = sqlx::query_scalar("SELECT encode(sha256($1::bytea),'hex')")
        .bind(id.to_string().as_bytes())
        .fetch_one(&pool)
        .await
        .unwrap();
    let stored: String = sqlx::query_scalar(
        "SELECT payload_hash FROM auth_webauthn_ceremony_bindings WHERE ceremony_id=$1",
    )
    .bind(ceremony)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, expected);
    let (status, value) = put(app(&f, true), id, valid).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(value["recorded"], true);
    assert_eq!(value["can_record"], false);
    assert_eq!(value["source"], "FORM");
    assert_eq!(value["masked"], "••••••-•••••••");
    let metadata: (Option<Uuid>, Uuid) =
        sqlx::query_as("SELECT import_run_id,recorded_by FROM employee_rrn WHERE employee_id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(metadata, (None, *f.principal.user_id.as_uuid()));
    let audit: Value = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE target_id=$1 AND action='employee.rrn_record'",
    )
    .bind(id.to_string())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!audit.to_string().contains("234567"));
    let valid = body(&pool, &mut f, id).await;
    refusal(app(&f, true), id, valid, 409, "rrn_already_recorded").await;
    let valid = body(&pool, &mut f, other).await;
    let (status, conflict) = put(app(&f, true), other, valid).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["error"]["code"], "rrn_in_use");
    assert!(!conflict.to_string().contains(&id.to_string()));
    assert!(!conflict.to_string().contains("Subject"));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn failed_audit_never_seals_or_writes(pool: PgPool) {
    let mut f = fixture(&pool).await;
    sqlx::raw_sql("CREATE FUNCTION synthetic_record_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='employee.rrn_record' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_record_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_record_failure();").execute(&pool).await.unwrap();
    let id = f.ids[0];
    let valid = body(&pool, &mut f, id).await;
    let (status, _) = put(app(&f, true), id, valid).await;
    assert!(status.is_server_error());
    assert_eq!(f.vault.0.load(Ordering::SeqCst), 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM employee_rrn WHERE org_id=$1")
        .bind(f.principal.org_id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_record_commands_cannot_claim_the_same_number(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let [id, other] = f.ids;
    let one = body(&pool, &mut f, id).await;
    let two = body(&pool, &mut f, other).await;
    let (a, b) = tokio::join!(put(app(&f, true), id, one), put(app(&f, true), other, two));
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn expired_step_up_never_seals_or_writes(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let id = f.ids[0];
    let valid = body(&pool, &mut f, id).await;
    let ceremony = valid["step_up"]["assertion"]["ceremony_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    sqlx::query("UPDATE auth_webauthn_ceremony_bindings SET created_at=now()-interval '6 minutes' WHERE ceremony_id=$1")
        .bind(ceremony).execute(&pool).await.unwrap();
    refusal(app(&f, true), id, valid, 401, "passkey_step_up_failed").await;
    assert_eq!(f.vault.0.load(Ordering::SeqCst), 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM employee_rrn WHERE org_id=$1")
        .bind(f.principal.org_id.as_uuid())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn status_projects_the_live_cedar_recording_decision(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let id = f.ids[0];
    let status = f.hr.rrn_status(f.principal.clone(), id).await.unwrap();
    assert_eq!(serde_json::to_value(status).unwrap()["can_record"], true);
    // A stale principal role must not override the live account's Cedar facts.
    let member =
        seed_active_user(&pool, *f.principal.org_id.as_uuid(), "MEMBER", "stale-role").await;
    f.principal.user_id = member;
    f.key = SoftKey::enroll(&pool, f.principal.org_id, member).await;
    let status = f.hr.rrn_status(f.principal.clone(), id).await.unwrap();
    assert_eq!(serde_json::to_value(status).unwrap()["can_record"], false);
    let valid = body(&pool, &mut f, id).await;
    refusal(app(&f, true), id, valid, 403, "forbidden").await;
    assert_eq!(f.vault.0.load(Ordering::SeqCst), 0);
}
