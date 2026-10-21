use crate::authz::authorize_org_manage;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::rollout::dto::ConsoleRolloutResponse;
use crate::rollout::dto::UpdateConsoleRolloutOptInRequest;
use crate::rollout::status::CONSOLE_ROLLOUT_USER_FEATURE_KEY;
use crate::rollout::status::fetch_console_rollout_status_tx;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::header;
use axum::response::IntoResponse;
use console_kernel_core::AuditAction;
use console_kernel_core::AuditEvent;
use console_kernel_core::TraceContext;
use console_platform_authz::Feature;
use console_platform_db::DbError;
use console_platform_db::with_audits;
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use time::OffsetDateTime;

// ---------------------------------------------------------------------------
// New-console rollout handlers (per-org flag + per-user opt-in)
// ---------------------------------------------------------------------------

pub(crate) async fn get_console_rollout(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::Login)?;
    let org = current_org()?;
    let user_id = principal.user_id;
    let status =
        with_org_conn::<_, ConsoleRolloutResponse, RestError>(state.pool(), org, move |tx| {
            Box::pin(async move { fetch_console_rollout_status_tx(tx, user_id).await })
        })
        .await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(status)))
}

pub(crate) async fn update_console_rollout_opt_in(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<UpdateConsoleRolloutOptInRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::Login)?;
    let org = current_org()?;
    let actor = principal.user_id;
    let opt_in = body.opt_in;
    let now = OffsetDateTime::now_utc();

    let status =
        with_audits::<_, ConsoleRolloutResponse, RestError>(state.pool(), org, move |tx| {
            Box::pin(async move {
                let before_preferences: Option<serde_json::Value> = sqlx::query_scalar(
                    r#"
                    SELECT preferences_json
                    FROM user_feature_preferences
                    WHERE user_id = $1 AND feature_key = $2
                    FOR UPDATE
                    "#,
                )
                .bind(*actor.as_uuid())
                .bind(CONSOLE_ROLLOUT_USER_FEATURE_KEY)
                .fetch_optional(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                let before_opt_in = before_preferences
                    .as_ref()
                    .and_then(|value| value.get("opt_in"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);

                let after_preferences = serde_json::json!({ "opt_in": opt_in });
                sqlx::query(
                    r#"
                    INSERT INTO user_feature_preferences (
                        org_id, user_id, feature_key, preferences_json, schema_version
                    ) VALUES ($1, $2, $3, $4, 1)
                    ON CONFLICT (org_id, user_id, feature_key) DO UPDATE SET
                        preferences_json = EXCLUDED.preferences_json,
                        schema_version = EXCLUDED.schema_version,
                        updated_at = now()
                    "#,
                )
                .bind(*org.as_uuid())
                .bind(*actor.as_uuid())
                .bind(CONSOLE_ROLLOUT_USER_FEATURE_KEY)
                .bind(after_preferences)
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;

                let status = fetch_console_rollout_status_tx(tx, actor).await?;
                let action =
                    AuditAction::new("console.opt_in_update").map_err(RestError::from_kernel)?;
                let event = AuditEvent::new(
                    Some(actor),
                    action,
                    "user_feature_preference",
                    format!("{}:{CONSOLE_ROLLOUT_USER_FEATURE_KEY}", actor),
                    TraceContext::generate(),
                    now,
                )
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({
                        "feature_key": CONSOLE_ROLLOUT_USER_FEATURE_KEY,
                        "opt_in": before_opt_in,
                        "org_enabled": status.org_enabled,
                        "legacy_kill_switch_enabled": status.legacy_kill_switch_enabled,
                        "effective_new_console": status.org_enabled && before_opt_in && !status.legacy_kill_switch_enabled,
                    })),
                    Some(serde_json::json!({
                        "feature_key": CONSOLE_ROLLOUT_USER_FEATURE_KEY,
                        "opt_in": status.user_opted_in,
                        "org_enabled": status.org_enabled,
                        "effective_new_console": status.effective_new_console,
                    })),
                );
                Ok((status, vec![event]))
            })
        })
        .await?;

    Ok(Json(status))
}
