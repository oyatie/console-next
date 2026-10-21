use crate::context::request::enrollment_user_context;
use crate::device_login::token::generate_device_login_token;
use crate::device_login::token::hash_device_login_token;
use crate::device_login::tx::lock_handoff_account_tx;
use crate::dto::device::EnrollHandoffRequest;
use crate::dto::device::EnrollHandoffResponse;
use crate::error::RestError;
use crate::limits::DEVICE_LOGIN_HANDOFF_TTL;
use crate::limits::ENROLL_HANDOFF_TTL;
use crate::rate_limit::passkey_error;
use crate::state::AuthRestState;
use crate::urls::build_enroll_url;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use console_platform_db::DbError;
use time::OffsetDateTime;
use uuid::Uuid;

/// Mint a cross-device passkey-enrollment handoff for the AUTHENTICATED user.
///
/// SELF-ONLY: the target user id and org come from the caller's VERIFIED access
/// token (`authenticated_user_context`), NEVER from the request body, so a caller
/// can only ever mint a handoff for itself — there is no path to hand off another
/// user's enrollment.
///
/// Scoped to passkey enrollment: the returned code is a fresh single-use,
/// short-TTL (5 min) bootstrap credential for THIS user, redeemed on a second
/// device (a phone scanning the QR) through the ordinary first-sign-in path. The
/// phone lands on its own onboarding page and enrolls a platform passkey there —
/// no Bluetooth / caBLE hybrid tunnel.
///
/// Step-up gate (mirrors `start_registration` exactly): when the caller is ALREADY
/// enrolled (has >=1 passkey, i.e. this is add-a-device), a fresh `step_up`
/// assertion of an existing passkey (UV required) is mandatory before a handoff is
/// minted, so a stolen bearer token alone cannot mint a device-enrollment code. A
/// mid-onboarding caller (zero passkeys) is exempt — there is nothing to assert,
/// and the redeem on the phone still gates the actual enrollment.
///
/// Audited inside `issue_self_enroll_handoff` as
/// `auth.passkey.enroll_handoff_issued`; the code value is never logged.
pub(crate) async fn enroll_handoff(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<EnrollHandoffRequest>,
) -> Result<Json<EnrollHandoffResponse>, RestError> {
    let services = state.services()?;
    // SELF-ONLY: user + org are taken from the verified token, never the body.
    let (user_id, org_id, _) = enrollment_user_context(&state.pool, services, &headers).await?;

    // Step-up gate: an already-enrolled user MUST assert an existing passkey (UV)
    // before a fresh enrollment handoff is minted; a user with zero passkeys is
    // mid-onboarding and exempt — identical to `start_registration`.
    let existing_passkeys = services
        .passkeys
        .count_user_passkeys(&state.pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    if existing_passkeys > 0 {
        let step_up = body.step_up.ok_or_else(|| {
            RestError::unauthorized(
                "minting an enrollment handoff requires a step-up assertion of an existing passkey",
            )
        })?;
        services
            .passkeys
            .verify_step_up_for_user(
                &state.pool,
                step_up.ceremony_id,
                step_up.credential,
                user_id,
            )
            .await
            .map_err(|err| passkey_error(err, "passkey step-up failed"))?;
    }

    let now = OffsetDateTime::now_utc();
    let issue = services
        .bootstrap_credentials
        .issue_self_enroll_handoff(&state.pool, user_id, org_id, now, ENROLL_HANDOFF_TTL)
        .await
        .map_err(RestError::from_provisioning)?;
    let handoff_id = Uuid::new_v4();
    let poll_token = generate_device_login_token("console_dlp_");
    let approve_token = generate_device_login_token("console_dla_");

    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    lock_handoff_account_tx(&mut tx, org_id, user_id).await?;
    sqlx::query(
        r#"
        INSERT INTO auth_device_login_handoffs (
            id,
            poll_token_hash,
            approve_token_hash,
            issued_at,
            expires_at,
            target_user_id,
            target_org_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(handoff_id)
    .bind(hash_device_login_token(&poll_token))
    .bind(hash_device_login_token(&approve_token))
    .bind(now)
    .bind(issue.expires_at.min(now + DEVICE_LOGIN_HANDOFF_TTL))
    .bind(user_id)
    .bind(*org_id.as_uuid())
    // rls-arming: ok auth_device_login_handoffs is a global pre-auth table.
    .execute(tx.as_mut())
    .await
    .map_err(|err| RestError::internal(err.to_string()))?;

    tx.commit().await.map_err(DbError::Sqlx)?;

    Ok(Json(EnrollHandoffResponse {
        enroll_url: build_enroll_url(
            &services.rp_origin,
            issue.token.as_str(),
            Some(&approve_token),
        ),
        otp: issue.token.as_str().to_owned(),
        expires_at: issue.expires_at,
        poll_token,
    }))
}
