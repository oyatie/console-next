//! BW-29 step-up kinds: a verified step-up for a governed act is recorded in
//! `step_up_assertions` once, and `step_up_shared_authenticator` compares the
//! credential rows of two records (decisions D0.2; spec bw29 §3, rows 17-18).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::OrgId;
use console_platform_auth::{
    MobilePasskeyStepUpAssertion, MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope,
    MobileStepUpActionKind, PasskeyRegistrationStart, PasskeyService, StoredPasskey,
    WebauthnSettings,
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use time::Duration;
use url::Url;
use uuid::Uuid;
use webauthn_authenticator_rs::{WebauthnAuthenticator, softpasskey::SoftPasskey};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../db/migrations");

async fn runtime_pool(owner: &PgPool) -> PgPool {
    PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

fn origin() -> Url {
    Url::parse("https://auth.example.com").unwrap()
}

fn service() -> PasskeyService {
    PasskeyService::new(WebauthnSettings {
        rp_id: "example.com".into(),
        rp_origin: origin(),
        rp_name: "Console".into(),
        extra_allowed_origins: vec![],
        ceremony_ttl: Duration::minutes(5),
    })
    .unwrap()
}

struct Holder {
    user: Uuid,
    key: StoredPasskey,
    authenticator: WebauthnAuthenticator<SoftPasskey>,
}

async fn holder(owner: &PgPool, runtime: &PgPool) -> Holder {
    let user: Uuid = sqlx::query_scalar(
        "INSERT INTO users(display_name,roles,org_id) VALUES ('Step-up',ARRAY['SUPER_ADMIN'],$1) RETURNING id",
    )
    .bind(*OrgId::one().as_uuid())
    .fetch_one(owner)
    .await
    .unwrap();
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let start = service()
        .start_registration(
            runtime,
            OrgId::one(),
            PasskeyRegistrationStart {
                user_id: user,
                username: user.to_string(),
                display_name: "Step-up".into(),
            },
        )
        .await
        .unwrap();
    let mut challenge = start.challenge;
    if let Some(selection) = challenge.public_key.authenticator_selection.as_mut() {
        selection.require_resident_key = false;
    }
    let credential = authenticator.do_registration(origin(), challenge).unwrap();
    let key = service()
        .finish_registration(runtime, OrgId::one(), start.ceremony_id, credential)
        .await
        .unwrap();
    Holder {
        user,
        key,
        authenticator,
    }
}

async fn envelope(
    runtime: &PgPool,
    holder: &mut Holder,
    binding: &MobilePasskeyStepUpBinding,
) -> MobilePasskeyStepUpEnvelope {
    let start = service()
        .start_mobile_step_up(runtime, holder.user, binding.clone())
        .await
        .unwrap();
    let mut challenge = serde_json::to_value(start.challenge).unwrap();
    challenge["publicKey"]["allowCredentials"] =
        serde_json::json!([{"type": "public-key", "id": holder.key.credential_id}]);
    let credential = holder
        .authenticator
        .do_authentication(origin(), serde_json::from_value(challenge).unwrap())
        .unwrap();
    MobilePasskeyStepUpEnvelope {
        binding: binding.clone(),
        assertion: MobilePasskeyStepUpAssertion {
            ceremony_id: start.ceremony_id,
            credential,
        },
    }
}

fn exception_decide(object_id: Uuid) -> MobilePasskeyStepUpBinding {
    MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        object_id,
        "9f".repeat(32),
    )
}

async fn record(
    runtime: &PgPool,
    holder: &Holder,
    envelope: MobilePasskeyStepUpEnvelope,
    expected: &MobilePasskeyStepUpBinding,
) -> Result<Uuid, String> {
    let mut tx = runtime.begin().await.unwrap();
    let id = service()
        .verify_and_record_step_up_in_tx(&mut tx, envelope, holder.user, expected)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.unwrap();
    Ok(id)
}

async fn shared(owner: &PgPool, first: Option<Uuid>, second: Option<Uuid>) -> bool {
    sqlx::query_scalar("SELECT step_up_shared_authenticator($1, $2)")
        .bind(first)
        .bind(second)
        .fetch_one(owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_verified_step_up_is_recorded_once_and_compared_by_credential(owner: PgPool) {
    let runtime = runtime_pool(&owner).await;
    let mut first = holder(&owner, &runtime).await;
    let mut second = holder(&owner, &runtime).await;
    let binding = exception_decide(Uuid::new_v4());

    let env = envelope(&runtime, &mut first, &binding).await;
    let replay = MobilePasskeyStepUpEnvelope {
        binding: env.binding.clone(),
        assertion: MobilePasskeyStepUpAssertion {
            ceremony_id: env.assertion.ceremony_id,
            credential: env.assertion.credential.clone(),
        },
    };
    let a = record(&runtime, &first, env, &binding).await.unwrap();
    let row: (Uuid, Uuid, String, String) = sqlx::query_as(
        "SELECT user_id, credential_row_id, action_kind, payload_hash FROM step_up_assertions WHERE ceremony_id = $1",
    )
    .bind(a)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            first.user,
            first.key.id,
            "EXCEPTION_DECIDE".into(),
            "9f".repeat(32)
        )
    );
    assert!(
        record(&runtime, &first, replay, &binding).await.is_err(),
        "a consumed ceremony cannot be recorded twice"
    );

    let a2 = {
        let env = envelope(&runtime, &mut first, &binding).await;
        record(&runtime, &first, env, &binding).await.unwrap()
    };
    let b = {
        let env = envelope(&runtime, &mut second, &binding).await;
        record(&runtime, &second, env, &binding).await.unwrap()
    };
    assert!(shared(&owner, Some(a), Some(a)).await, "same id twice");
    assert!(shared(&owner, Some(a), Some(a2)).await, "same credential");
    assert!(
        !shared(&owner, Some(a), Some(b)).await,
        "distinct credentials"
    );
    assert!(
        shared(&owner, Some(a), Some(Uuid::new_v4())).await,
        "unknown fails closed"
    );
    assert!(!shared(&owner, Some(a), None).await, "no pair");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_mismatched_or_legacy_binding_is_not_recorded(owner: PgPool) {
    let runtime = runtime_pool(&owner).await;
    let mut first = holder(&owner, &runtime).await;
    let binding = exception_decide(Uuid::new_v4());
    let env = envelope(&runtime, &mut first, &binding).await;
    let other_payload = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        binding.object_id,
        "00".repeat(32),
    );
    assert!(record(&runtime, &first, env, &other_payload).await.is_err());

    let legacy = MobilePasskeyStepUpBinding::approval_decision(Uuid::new_v4(), None);
    let env = envelope(&runtime, &mut first, &legacy).await;
    assert!(record(&runtime, &first, env, &legacy).await.is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM step_up_assertions")
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn the_binding_check_refuses_an_unhashed_or_unknown_kind(owner: PgPool) {
    let insert = |kind: &'static str, reason: &'static str, hash: Option<&'static str>| {
        let owner = owner.clone();
        async move {
            let ceremony: Uuid = sqlx::query_scalar(
                "INSERT INTO auth_webauthn_ceremonies (id, user_id, ceremony_kind, challenge_json, state_json, expires_at) \
                 VALUES (gen_random_uuid(), NULL, 'authentication', '{}', '{}', now() + interval '1 minute') RETURNING id",
            )
            .fetch_one(&owner)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO auth_webauthn_ceremony_bindings (ceremony_id, action_kind, object_id, reason_key, replay_attempt, payload_hash) \
                 VALUES ($1, $2, gen_random_uuid(), $3, NULL, $4)",
            )
            .bind(ceremony)
            .bind(kind)
            .bind(reason)
            .bind(hash)
            .execute(&owner)
            .await
        }
    };
    let hash = "ab".repeat(32).leak() as &'static str;
    assert!(
        insert("EXIT_CONFIRM", "passkey_step_up_exit_confirm", Some(hash))
            .await
            .is_ok()
    );
    assert!(
        insert("EXIT_CONFIRM", "passkey_step_up_exit_confirm", None)
            .await
            .is_err()
    );
    assert!(
        insert("ROOT_ACCESS", "passkey_step_up_root_access", Some(hash))
            .await
            .is_err()
    );
    assert!(
        insert("POLL_VOTE", "operations_passkey_poll_vote", Some(hash))
            .await
            .is_err()
    );
}
