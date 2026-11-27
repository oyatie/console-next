// SPDX-License-Identifier: LicenseRef-Proprietary
//! Ops holder recovery contact management, 10-code single-use generation, and
//! recovery sign-in handlers (`/api/v1/auth/recovery/*`).

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use console_platform_db::{DbError, insert_audit_event, with_org_conn};
use console_platform_provisioning::ops_self_recovery::{
    RECOVERY_CODE_COUNT, RecoveryCodesSummary, generate_recovery_codes, issue_recovery_challenge,
    load_recovery_codes_summary_tx, load_recovery_contact_status_tx, redeem_recovery_code_in_tx,
    upsert_recovery_contact,
};
use console_platform_request_context::TrustedClientIp;
use sqlx::Row;
use time::{Duration, OffsetDateTime};

use crate::audit::{auth_audit_event, record_anonymous_auth_audit};
use crate::context::grants::resolve_feature_grant_keys_for_user_in_tx;
use crate::context::load::load_user_auth_context_tx;
use crate::context::request::enrollment_user_context;
use crate::cookies::{refresh_set_cookie, wants_cookie_transport, with_refresh_cookie};
use crate::dto::passkey::StepUpAssertion;
use crate::dto::recovery::{
    GenerateRecoveryCodesRequest, GenerateRecoveryCodesResponse, RecoveryChallengeRequest,
    RecoveryChallengeResponse, RecoveryRedeemRequest, RecoveryRedeemResponse,
    RecoveryStatusResponse, UpsertRecoveryContactRequest,
};
use crate::error::RestError;
use crate::rate_limit::{RateLimitEndpoint, passkey_error, rate_limit};
use crate::state::AuthRestState;
use crate::token::issue::issue_token_pair_in_tx;

async fn verify_step_up_if_enrolled(
    state: &AuthRestState,
    user_id: uuid::Uuid,
    org_id: console_kernel_core::OrgId,
    step_up: Option<StepUpAssertion>,
) -> Result<(), RestError> {
    let services = state.services()?;
    let has_passkey = console_platform_auth::user_has_passkey(&state.pool, org_id, user_id)
        .await
        .map_err(|err| RestError::internal(err.to_string()))?;
    if !has_passkey {
        return Ok(());
    }
    let step_up = step_up.ok_or_else(|| RestError {
        status: StatusCode::PRECONDITION_REQUIRED,
        code: "passkey_step_up_required",
        message: "a fresh passkey step-up assertion is required".to_owned(),
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
        .map_err(|err| passkey_error(err, "passkey step-up failed"))
}

pub(crate) async fn recovery_status(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<RecoveryStatusResponse>, RestError> {
    let services = state.services()?;
    let (uid, org_id, _) = enrollment_user_context(&state.pool, services, &headers).await?;
    let out = with_org_conn::<_, _, RestError>(&state.pool, org_id, move |tx| {
        Box::pin(async move {
            let row = sqlx::query(
                "SELECT is_tenant_ops AND is_active AS is_ops,
                        (SELECT count(*) FROM users WHERE org_id = $1 AND is_tenant_ops AND is_active) AS holder_count
                   FROM users WHERE org_id = $1 AND id = $2",
            )
            .bind(org_id.as_uuid())
            .bind(uid)
            .fetch_optional(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            let Some(row) = row else {
                return Err(RestError::unauthorized("account not found"));
            };
            let is_ops: bool = row.try_get("is_ops").map_err(DbError::Sqlx)?;
            let holder_count: i64 = row.try_get("holder_count").map_err(DbError::Sqlx)?;
            if !is_ops {
                return Ok(RecoveryStatusResponse {
                    eligible: false,
                    is_tenant_ops: false,
                    holder_count,
                    max_holders: 2,
                    contact: None,
                    codes: RecoveryCodesSummary {
                        total: RECOVERY_CODE_COUNT,
                        remaining: 0,
                        generated_at: None,
                    },
                });
            }
            let contact = load_recovery_contact_status_tx(tx, org_id, uid)
                .await
                .map_err(RestError::from_provisioning)?;
            let codes = load_recovery_codes_summary_tx(tx, org_id, uid)
                .await
                .map_err(RestError::from_provisioning)?;
            Ok(RecoveryStatusResponse {
                eligible: true,
                is_tenant_ops: true,
                holder_count,
                max_holders: 2,
                contact,
                codes,
            })
        })
    })
    .await?;
    Ok(Json(out))
}

pub(crate) async fn upsert_contact(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<UpsertRecoveryContactRequest>,
) -> Result<Json<console_platform_provisioning::ops_self_recovery::RecoveryContactStatus>, RestError>
{
    if !body.consent_accepted {
        return Err(RestError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "recovery_contact_consent_required",
            message: "accept the recovery contact collection notice before saving".to_owned(),
        });
    }
    let services = state.services()?;
    let (uid, org_id, _) = enrollment_user_context(&state.pool, services, &headers).await?;
    verify_step_up_if_enrolled(&state, uid, org_id, body.step_up).await?;
    let status = upsert_recovery_contact(
        &state.pool,
        &services.recovery_cipher,
        org_id,
        uid,
        body.channel,
        &body.value,
        OffsetDateTime::now_utc(),
    )
    .await
    .map_err(RestError::from_provisioning)?;
    Ok(Json(status))
}

pub(crate) async fn generate_codes(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Json(body): Json<GenerateRecoveryCodesRequest>,
) -> Result<Json<GenerateRecoveryCodesResponse>, RestError> {
    let services = state.services()?;
    let (uid, org_id, _) = enrollment_user_context(&state.pool, services, &headers).await?;
    verify_step_up_if_enrolled(&state, uid, org_id, body.step_up).await?;
    let batch = generate_recovery_codes(
        &state.pool,
        &services.bootstrap_credentials,
        org_id,
        uid,
        OffsetDateTime::now_utc(),
    )
    .await
    .map_err(RestError::from_provisioning)?;
    Ok(Json(batch))
}

pub(crate) async fn start_recovery_challenge(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<RecoveryChallengeRequest>,
) -> Result<Json<RecoveryChallengeResponse>, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::RecoveryChallenge,
        now,
    )
    .await?;
    let issued = issue_recovery_challenge(
        &state.pool,
        &services.bootstrap_credentials,
        &services.recovery_cipher,
        services.email_sender.as_ref(),
        &body.identifier,
        now,
    )
    .await
    .map_err(RestError::from_provisioning)?;
    Ok(Json(RecoveryChallengeResponse {
        sent: issued.sent,
        expires_at: issued.expires_at,
    }))
}

pub(crate) async fn redeem_recovery(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    trusted_client_ip: Option<Extension<TrustedClientIp>>,
    Json(body): Json<RecoveryRedeemRequest>,
) -> Result<Response, RestError> {
    let services = state.services()?;
    let now = OffsetDateTime::now_utc();
    rate_limit(
        &state.pool,
        &headers,
        trusted_client_ip.map(|Extension(ip)| ip),
        RateLimitEndpoint::RecoveryRedeem,
        now,
    )
    .await?;

    let mut tx = state.pool.begin().await.map_err(DbError::Sqlx)?;
    let redemption = match redeem_recovery_code_in_tx(
        &mut tx,
        &services.bootstrap_credentials,
        body.recovery_code.trim(),
        body.contact_code.trim(),
        now,
        Duration::minutes(30),
    )
    .await
    {
        Ok(r) => r,
        Err(err) => {
            tx.rollback().await.map_err(DbError::Sqlx)?;
            record_anonymous_auth_audit(
                &state.pool,
                "auth.recovery_code.redeem_failed",
                serde_json::json!({ "outcome": "rejected" }),
            )
            .await
            .ok();
            return Err(RestError::from_provisioning(err));
        }
    };

    let mut user = load_user_auth_context_tx(&mut tx, redemption.user_id).await?;
    user.feature_grants = resolve_feature_grant_keys_for_user_in_tx(&mut tx, &user).await?;
    let tokens = issue_token_pair_in_tx(&mut tx, services, &user, true).await?;
    sqlx::query(
        "INSERT INTO auth_legacy_otp_family_sources (family_id, source_id, user_id, org_id)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(tokens.family_id)
    .bind(redemption.source_credential_id)
    .bind(redemption.user_id)
    .bind(*redemption.org_id.as_uuid())
    .execute(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;

    let signin_audit = auth_audit_event(
        redemption.org_id,
        redemption.user_id,
        "auth.recovery_code.signin",
        serde_json::json!({
            "refresh_family_id": tokens.family_id,
            "cancelled_recovery_request": redemption.cancelled_recovery_request,
        }),
    )?;
    insert_audit_event(&mut tx, &signin_audit).await?;
    tx.commit().await.map_err(DbError::Sqlx)?;

    if wants_cookie_transport(&headers) {
        let max_age = (tokens.refresh_expires_at - now).whole_seconds();
        let cookie = refresh_set_cookie(&tokens.refresh_token, max_age);
        let response = Json(RecoveryRedeemResponse {
            access_token: tokens.access_token,
            refresh_token: None,
            token_type: "Bearer",
            refresh_expires_at: tokens.refresh_expires_at,
            requires_passkey_setup: true,
            privacy_consent_accepted: tokens.privacy_consent_accepted,
            cancelled_recovery_request: redemption.cancelled_recovery_request,
        })
        .into_response();
        Ok(with_refresh_cookie(response, cookie))
    } else {
        Ok(Json(RecoveryRedeemResponse {
            access_token: tokens.access_token,
            refresh_token: Some(tokens.refresh_token),
            token_type: "Bearer",
            refresh_expires_at: tokens.refresh_expires_at,
            requires_passkey_setup: true,
            privacy_consent_accepted: tokens.privacy_consent_accepted,
            cancelled_recovery_request: redemption.cancelled_recovery_request,
        })
        .into_response())
    }
}
