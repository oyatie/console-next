use crate::context::request::authenticated_user_context;
use crate::dto::passkey::PasskeySummary;
use crate::dto::passkey::StepUpAssertion;
use crate::error::RestError;
use crate::rate_limit::passkey_error;
use crate::state::AuthRestState;
use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
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
                    SELECT id, created_at, last_used_at
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
