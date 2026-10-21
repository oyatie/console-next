use crate::authz::authorize_org_manage;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::rollout::dto::ConsoleRolloutResponse;
use crate::rollout::dto::UpdateConsoleLegacyKillSwitchRequest;
use crate::rollout::dto::UpdateConsoleRolloutOrgFlagRequest;
use crate::rollout::status::CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY;
use crate::rollout::status::CONSOLE_ROLLOUT_FLAG_KEY;
use crate::rollout::status::fetch_console_rollout_status_tx;
use crate::rollout::status::normalize_console_rollout_note;
use crate::state::IdentityRestState;
use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use console_kernel_core::AuditAction;
use console_kernel_core::AuditEvent;
use console_kernel_core::TraceContext;
use console_platform_authz::Feature;
use console_platform_db::DbError;
use console_platform_db::with_audits;
use console_platform_request_context::current_org;
use sqlx::Row;
use time::OffsetDateTime;

pub(crate) async fn update_console_rollout_org_flag(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<UpdateConsoleRolloutOrgFlagRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let org = current_org()?;
    let actor = principal.user_id;
    let enabled = body.enabled;
    let rollout_note = normalize_console_rollout_note(body.rollout_note)?;
    let now = OffsetDateTime::now_utc();

    let status =
        with_audits::<_, ConsoleRolloutResponse, RestError>(state.pool(), org, move |tx| {
            Box::pin(async move {
                let before_row = sqlx::query(
                    r#"
                    SELECT enabled, rollout_note
                    FROM org_runtime_flags
                    WHERE flag_key = $1
                    FOR UPDATE
                    "#,
                )
                .bind(CONSOLE_ROLLOUT_FLAG_KEY)
                .fetch_optional(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                let before_snapshot = match before_row {
                    Some(row) => Some(serde_json::json!({
                        "flag_key": CONSOLE_ROLLOUT_FLAG_KEY,
                        "enabled": row.try_get::<bool, _>("enabled").map_err(DbError::Sqlx)?,
                        "rollout_note": row
                            .try_get::<Option<String>, _>("rollout_note")
                            .map_err(DbError::Sqlx)?,
                    })),
                    None => None,
                };

                sqlx::query(
                    r#"
                    INSERT INTO org_runtime_flags (org_id, flag_key, enabled, rollout_note, set_by)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (org_id, flag_key) DO UPDATE SET
                        enabled = EXCLUDED.enabled,
                        rollout_note = EXCLUDED.rollout_note,
                        set_by = EXCLUDED.set_by
                    "#,
                )
                .bind(*org.as_uuid())
                .bind(CONSOLE_ROLLOUT_FLAG_KEY)
                .bind(enabled)
                .bind(rollout_note.as_deref())
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;

                let status = fetch_console_rollout_status_tx(tx, actor).await?;
                let action =
                    AuditAction::new("console.org_flag_update").map_err(RestError::from_kernel)?;
                let event = AuditEvent::new(
                    Some(actor),
                    action,
                    "org_runtime_flag",
                    CONSOLE_ROLLOUT_FLAG_KEY.to_owned(),
                    TraceContext::generate(),
                    now,
                )
                .with_org(org)
                .with_snapshots(
                    before_snapshot,
                    Some(serde_json::json!({
                        "flag_key": CONSOLE_ROLLOUT_FLAG_KEY,
                        "enabled": enabled,
                        "rollout_note": rollout_note,
                    })),
                );
                Ok((status, vec![event]))
            })
        })
        .await?;

    Ok(Json(status))
}

pub(crate) async fn update_console_legacy_kill_switch(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<UpdateConsoleLegacyKillSwitchRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::RoleManage)?;
    let org = current_org()?;
    let actor = principal.user_id;
    let enabled = body.enabled;
    let reason = normalize_console_rollout_note(body.reason)?;
    let now = OffsetDateTime::now_utc();

    let status = with_audits::<_, ConsoleRolloutResponse, RestError>(
        state.pool(),
        org,
        move |tx| {
            Box::pin(async move {
                let before_row = sqlx::query(
                    r#"
                    SELECT enabled, rollout_note
                    FROM org_runtime_flags
                    WHERE flag_key = $1
                    FOR UPDATE
                    "#,
                )
                .bind(CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY)
                .fetch_optional(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                let before_snapshot = match before_row {
                    Some(row) => Some(serde_json::json!({
                        "flag_key": CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY,
                        "enabled": row.try_get::<bool, _>("enabled").map_err(DbError::Sqlx)?,
                        "reason": row
                            .try_get::<Option<String>, _>("rollout_note")
                            .map_err(DbError::Sqlx)?,
                    })),
                    None => None,
                };

                sqlx::query(
                    r#"
                    INSERT INTO org_runtime_flags (org_id, flag_key, enabled, rollout_note, set_by)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (org_id, flag_key) DO UPDATE SET
                        enabled = EXCLUDED.enabled,
                        rollout_note = EXCLUDED.rollout_note,
                        set_by = EXCLUDED.set_by
                    "#,
                )
                .bind(*org.as_uuid())
                .bind(CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY)
                .bind(enabled)
                .bind(reason.as_deref())
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;

                let status = fetch_console_rollout_status_tx(tx, actor).await?;
                let action = AuditAction::new("console.kill_switch")
                    .map_err(RestError::from_kernel)?;
                let event = AuditEvent::new(
                    Some(actor),
                    action,
                    "org_runtime_flag",
                    CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY,
                    TraceContext::generate(),
                    now,
                )
                .with_org(org)
                .with_snapshots(
                    before_snapshot,
                    Some(serde_json::json!({
                        "flag_key": CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY,
                        "enabled": enabled,
                        "reason": reason,
                        "org_rollout_enabled": status.org_rollout_enabled,
                        "user_opted_in": status.user_opted_in,
                        "effective_route": status.effective_route,
                        "effective_route_for_opted_in_user": status.effective_route_for_opted_in_user,
                        "effective_route_for_opted_out_user": status.effective_route_for_opted_out_user,
                        "overrides_individual_toggles": status.overrides_individual_toggles,
                    })),
                );
                Ok((status, vec![event]))
            })
        },
    )
    .await?;

    if enabled {
        tracing::warn!(
            event = "console_legacy_kill_switch_updated",
            actor_user_id = %actor,
            org_id = %org,
            enabled,
            "console legacy kill switch enabled"
        );
    } else {
        tracing::info!(
            event = "console_legacy_kill_switch_updated",
            actor_user_id = %actor,
            org_id = %org,
            enabled,
            "console legacy kill switch disabled"
        );
    }

    Ok(Json(status))
}
