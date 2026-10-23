use crate::context::load::load_user_auth_context_in_org;
use crate::context::request::enrollment_user_context;
use crate::context::request::ensure_registration_ceremony_owner;
use crate::context::request::session_family_from_headers;
use crate::dto::passkey::RegisterFinishRequest;
use crate::dto::passkey::RegisterFinishResponse;
use crate::dto::passkey::RegisterStartRequest;
use crate::dto::passkey::RegisterStartResponse;
use crate::error::RestError;
use crate::rate_limit::passkey_error;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use console_platform_auth::AuthError;
use console_platform_auth::PasskeyRegistrationStart;
use console_platform_db::DbError;
use time::OffsetDateTime;
use uuid::Uuid;

/// Start passkey registration for the AUTHENTICATED session user.
///
/// Registration is always an authenticated action now (initial-settings passkey
/// enrollment after an OTP first sign-in, or adding a device later). The
/// usernameless first sign-in goes through `/auth/otp/redeem`, not here, so this
/// path no longer accepts a bootstrap token.
///
/// Anti-silent-add step-up: when the caller ALREADY has one or more passkeys,
/// adding another requires a fresh step-up assertion (`step_up`) of an existing
/// passkey with user verification, so a stolen bearer token alone cannot enroll a
/// new credential. Initial enrollment (zero existing passkeys) needs no step-up —
/// there is no credential to assert, and the open bootstrap code still gates the
/// finish.
pub(crate) async fn start_registration(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<RegisterStartRequest>,
) -> Result<Json<RegisterStartResponse>, RestError> {
    let services = state.services()?;
    let (user_id, org_id, is_enrollment) =
        enrollment_user_context(&state.pool, services, &headers).await?;
    if is_enrollment {
        crate::consent::ensure_privacy_consent_accepted(&state.pool, org_id, user_id).await?;
    }
    let user = load_user_auth_context_in_org(&state.pool, org_id, user_id).await?;

    // Step-up gate: an already-enrolled user MUST assert an existing passkey (UV)
    // before a new credential challenge is issued. A user with zero passkeys is
    // doing initial enrollment and is exempt.
    let existing_passkeys = services
        .passkeys
        .count_user_passkeys(&state.pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    if existing_passkeys > 0 {
        let step_up = body.step_up.ok_or_else(|| {
            RestError::unauthorized(
                "adding a passkey requires a step-up assertion of an existing passkey",
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

    let ceremony = services
        .passkeys
        .start_registration(
            &state.pool,
            org_id,
            PasskeyRegistrationStart {
                user_id,
                // The authenticator shows the sign-in ID (decisions #33), never
                // the phone number the legacy label used.
                username: match body.username {
                    Some(username) => username,
                    None => console_platform_auth::current_sign_in_id(&state.pool, org_id, user_id)
                        .await
                        .map_err(|err| RestError::internal(err.to_string()))?
                        .unwrap_or(user.username),
                },
                display_name: body.display_name.unwrap_or(user.display_name),
            },
        )
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;

    let family_id = session_family_from_headers(services, &headers)?;
    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org_id.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .map_err(DbError::Sqlx)?;
    if console_platform_auth::lock_account_tx(&mut tx, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?
        != Some(true)
    {
        return Err(RestError::unauthorized("registration Account is inactive"));
    }
    // The key count can change while WebAuthn prepares the challenge. The
    // locked Account determines whether this is initial enrollment or add-device.
    let current_keys: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1 AND org_id=$2",
    )
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    if (current_keys == 0) != (existing_passkeys == 0) {
        return Err(RestError::unauthorized("registration authority changed"));
    }
    let live_family: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM auth_refresh_token_families \
         WHERE id=$1 AND user_id=$2 AND org_id=$3 AND revoked_at IS NULL FOR SHARE",
    )
    .bind(family_id)
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    if live_family != Some(family_id) {
        return Err(RestError::unauthorized("registration session was revoked"));
    }
    let source_id: Option<Uuid> = if current_keys == 0 {
        let source: Option<Uuid> = sqlx::query_scalar(
            "SELECT b.id FROM auth_legacy_otp_family_sources s \
             JOIN auth_bootstrap_credentials b ON b.id=s.source_id \
             WHERE s.family_id=$1 AND s.user_id=$2 AND s.org_id=$3 \
               AND b.user_id=$2 AND b.org_id=$3 AND b.issuance_version=0 \
               AND b.consumed_at IS NULL AND b.revoked_at IS NULL \
               AND b.expires_at>clock_timestamp() FOR SHARE OF b",
        )
        .bind(family_id)
        .bind(user_id)
        .bind(*org_id.as_uuid())
        .fetch_optional(tx.as_mut())
        .await
        .map_err(DbError::Sqlx)?;
        Some(source.ok_or_else(|| RestError::unauthorized("registration source is unavailable"))?)
    } else {
        None
    };
    let bound = sqlx::query(
        "INSERT INTO auth_legacy_registration_bindings \
         (ceremony_id,family_id,source_id,user_id,org_id,purpose) \
         SELECT id,$2,$3,$4,$5,$6 FROM auth_webauthn_ceremonies \
         WHERE id=$1 AND user_id=$4 AND ceremony_kind='registration' \
           AND consumed_at IS NULL AND expires_at>clock_timestamp()",
    )
    .bind(ceremony.ceremony_id)
    .bind(family_id)
    .bind(source_id)
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .bind(if source_id.is_some() {
        "legacy_otp"
    } else {
        "add_device"
    })
    .execute(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    if bound.rows_affected() != 1 {
        return Err(RestError::unauthorized("registration ceremony expired"));
    }
    // A bearer expiring during step-up verification or Account waiting must
    // not release a new registration challenge.
    if session_family_from_headers(services, &headers)? != family_id {
        return Err(RestError::unauthorized("registration session changed"));
    }
    tx.commit().await.map_err(DbError::Sqlx)?;

    Ok(Json(RegisterStartResponse {
        ceremony_id: ceremony.ceremony_id,
        challenge: serde_json::to_value(ceremony.challenge)
            .map_err(|err| RestError::internal(err.to_string()))?,
        expires_at: ceremony.expires_at,
    }))
}

/// Finish passkey registration for the AUTHENTICATED session user.
pub(crate) async fn finish_registration(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<RegisterFinishRequest>,
) -> Result<(StatusCode, Json<RegisterFinishResponse>), RestError> {
    let services = state.services()?;
    let (user_id, org_id, is_enrollment) =
        enrollment_user_context(&state.pool, services, &headers).await?;
    if is_enrollment {
        crate::consent::ensure_privacy_consent_accepted(&state.pool, org_id, user_id).await?;
    }
    let family_id = session_family_from_headers(services, &headers)?;
    ensure_registration_ceremony_owner(&state.pool, body.ceremony_id, user_id).await?;
    let now = OffsetDateTime::now_utc();

    // The signed credential, exact bound source and its consume commit together.
    // Any later failure rolls back the key, ceremony claim and success audit.
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    let passkey = services
        .passkeys
        .finish_registration_in_tx(&mut tx, org_id, body.ceremony_id, body.credential, now)
        .await
        .map_err(|err| match err {
            AuthError::Kernel(kernel) => RestError::from_kernel(kernel),
            other => RestError::internal(other.to_string()),
        })?;
    let binding: Option<(Uuid, Option<Uuid>, String)> = sqlx::query_as(
        "SELECT family_id,source_id,purpose FROM auth_legacy_registration_bindings \
         WHERE ceremony_id=$1 AND user_id=$2 AND org_id=$3",
    )
    .bind(body.ceremony_id)
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    let Some((bound_family, source_id, purpose)) = binding else {
        return Err(RestError::unauthorized(
            "registration authorization is unavailable",
        ));
    };
    if bound_family != family_id {
        return Err(RestError::unauthorized("registration session changed"));
    }
    let live_family: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM auth_refresh_token_families \
         WHERE id=$1 AND user_id=$2 AND org_id=$3 AND revoked_at IS NULL FOR SHARE",
    )
    .bind(family_id)
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    if live_family != Some(family_id) {
        return Err(RestError::unauthorized("registration session was revoked"));
    }
    let key_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM auth_webauthn_credentials WHERE user_id=$1 AND org_id=$2",
    )
    .bind(user_id)
    .bind(*org_id.as_uuid())
    .fetch_one(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    match (purpose.as_str(), source_id) {
        ("legacy_otp", Some(source)) if key_count == 1 => services
            .bootstrap_credentials
            .consume_bound_credential_tx(&mut tx, org_id, user_id, source, now)
            .await
            .map_err(RestError::from_provisioning)?,
        ("add_device", None) if key_count > 1 => {}
        _ => return Err(RestError::unauthorized("registration authority changed")),
    }
    // Verification may have waited for the Account or spent time checking the
    // signed WebAuthn response; an expired bearer cannot commit a new key.
    if session_family_from_headers(services, &headers)? != family_id {
        return Err(RestError::unauthorized("registration session changed"));
    }
    tx.commit()
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    // The client signs in with the new key right away, identifier-first, so a
    // key that kept no resident credential works too (decisions #33).
    let sign_in_id = console_platform_auth::current_sign_in_id(&state.pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;

    Ok((
        StatusCode::CREATED,
        Json(RegisterFinishResponse {
            passkey_id: passkey.id,
            user_id: passkey.user_id,
            credential_id: passkey.credential_id,
            sign_in_id,
        }),
    ))
}
