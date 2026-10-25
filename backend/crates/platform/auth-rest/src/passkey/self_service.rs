use crate::context::request::authenticated_user_context;
use crate::dto::passkey::StepUpAssertion;
use crate::dto::passkey::{PasskeyLabelPolicy, PasskeySummary};
use crate::error::RestError;
use crate::limits::PASSKEY_LABEL_MAX_LENGTH;
use crate::rate_limit::passkey_error;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use console_kernel_core::{AuditAction, AuditEvent, TraceContext, UserId};
use console_platform_db::DbError;
use console_platform_db::with_audits;
use console_platform_db::with_org_conn;
use serde::Deserialize;
use sqlx::Row;
use time::OffsetDateTime;
use uuid::Uuid;

/// List the AUTHENTICATED user's OWN passkey credentials through the auth
/// namespace, the only passkey-management surface. It is not behind the tenant
/// middleware, so it also works for PLATFORM accounts whose token is deliberately
/// rejected from tenant APIs.
pub(crate) async fn list_self_passkeys(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
) -> Result<Json<Vec<PasskeySummary>>, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(&state.pool, services, &headers).await?;

    let summaries =
        with_org_conn::<_, Vec<PasskeySummary>, RestError>(&state.pool, org_id, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    r#"
                    SELECT id, label, created_at, last_used_at
                    FROM auth_webauthn_credentials
                    WHERE user_id = $1
                    ORDER BY created_at
                    "#,
                )
                .bind(user_id)
                .fetch_all(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;

                rows.into_iter()
                    .map(|row| {
                        Ok(PasskeySummary {
                            id: row.try_get("id").map_err(DbError::Sqlx)?,
                            label: row.try_get("label").map_err(DbError::Sqlx)?,
                            created_at: row.try_get("created_at").map_err(DbError::Sqlx)?,
                            last_used_at: row.try_get("last_used_at").map_err(DbError::Sqlx)?,
                        })
                    })
                    .collect::<Result<Vec<_>, RestError>>()
            })
        })
        .await?;

    Ok(Json(summaries))
}

/// Non-secret display constraints, also readable before initial enrollment.
pub(crate) async fn passkey_label_policy() -> Json<PasskeyLabelPolicy> {
    Json(PasskeyLabelPolicy {
        label_max_length: PASSKEY_LABEL_MAX_LENGTH,
    })
}

pub(super) fn normalize_label(label: Option<String>) -> Result<Option<String>, RestError> {
    label
        .map(|label| {
            let label = label.trim();
            if label.is_empty() || label.chars().count() > PASSKEY_LABEL_MAX_LENGTH || label.chars().any(char::is_control)
            {
                return Err(RestError {
                    status: StatusCode::UNPROCESSABLE_ENTITY,
                    code: "passkey_label_invalid",
                    message: format!("passkey labels must contain 1 to {PASSKEY_LABEL_MAX_LENGTH} characters and no control characters"),
                });
            }
            Ok(label.to_owned())
        })
        .transpose()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RenamePasskeyRequest {
    pub(crate) label: Option<String>,
}

/// Only the credential's owner can change its display label; key material is untouched.
pub(crate) async fn rename_self_passkey(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<RenamePasskeyRequest>,
) -> Result<Json<PasskeySummary>, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(&state.pool, services, &headers).await?;
    let label = normalize_label(body.label)?;
    let summary = with_audits(&state.pool, org_id, move |tx| {
        Box::pin(async move {
            if console_platform_auth::lock_account_tx(tx, org_id, user_id)
                .await
                .map_err(DbError::Sqlx)? != Some(true)
            {
                return Err(RestError::unauthorized("inactive or missing Account"));
            }
            let row = sqlx::query("SELECT label,created_at,last_used_at FROM auth_webauthn_credentials WHERE id=$1 AND user_id=$2 AND org_id=$3 FOR UPDATE")
                .bind(id).bind(user_id).bind(org_id.as_uuid()).fetch_optional(tx.as_mut()).await.map_err(DbError::Sqlx)?
                .ok_or_else(|| RestError::not_found("passkey not found"))?;
            let previous: Option<String> = row.try_get("label").map_err(DbError::Sqlx)?;
            sqlx::query("UPDATE auth_webauthn_credentials SET label=$1 WHERE id=$2 AND user_id=$3 AND org_id=$4")
                .bind(&label).bind(id).bind(user_id).bind(org_id.as_uuid()).execute(tx.as_mut()).await.map_err(DbError::Sqlx)?;
            let now = console_platform_auth::authentication_time_tx(tx, OffsetDateTime::now_utc()).await.map_err(DbError::Sqlx)?;
            let event = AuditEvent::new(
                Some(UserId::from_uuid(user_id)), AuditAction::new("auth.passkey.rename").map_err(RestError::from_kernel)?,
                "auth_webauthn_credential", id.to_string(), TraceContext::generate(), now,
            ).with_org(org_id).with_snapshots(Some(serde_json::json!({"label": previous})), Some(serde_json::json!({"label": label})));
            Ok((PasskeySummary {
                id, label,
                created_at: row.try_get("created_at").map_err(DbError::Sqlx)?,
                last_used_at: row.try_get("last_used_at").map_err(DbError::Sqlx)?,
            }, vec![event]))
        })
    }).await?;
    Ok(Json(summary))
}

/// Body of `DELETE /auth/passkeys/{id}`: the caller's fresh step-up assertion
/// of one of their passkeys (ceremony from `passkey/login/start`).
#[derive(Debug, Deserialize)]
pub(crate) struct DeletePasskeyRequest {
    pub(crate) step_up: Option<StepUpAssertion>,
}

/// Revoke ONE of the authenticated user's OWN passkey credentials through the
/// auth namespace. Self-only and IDOR-hardened: the delete is constrained by both
/// credential id and caller id. The last-passkey floor prevents self-lockout.
///
/// Step-up: the caller must assert one of their passkeys (UV) in this request, so
/// a stolen bearer token alone cannot strip a user's credentials.
pub(crate) async fn delete_self_passkey(
    State(state): State<AuthRestState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    body: Option<Json<DeletePasskeyRequest>>,
) -> Result<impl IntoResponse, RestError> {
    let services = state.services()?;
    let (user_id, org_id) = authenticated_user_context(&state.pool, services, &headers).await?;
    let step_up = body.and_then(|Json(body)| body.step_up).ok_or_else(|| {
        RestError::unauthorized("removing a passkey requires a step-up assertion of your passkey")
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
    let now = OffsetDateTime::now_utc();

    with_audits::<_, (), RestError>(&state.pool, org_id, move |tx| {
        Box::pin(async move {
            let event = console_platform_auth::delete_self_passkey_tx(tx, org_id, user_id, id, now)
                .await
                .map_err(|error| match error {
                    console_platform_auth::AuthError::Kernel(error) => {
                        RestError::from_kernel(error)
                    }
                    console_platform_auth::AuthError::InvalidStoredData(_) => {
                        RestError::unauthorized("inactive or missing Account")
                    }
                    _ => RestError::internal("passkey deletion failed"),
                })?;

            Ok(((), vec![event]))
        })
    })
    .await?;

    Ok(StatusCode::NO_CONTENT)
}
