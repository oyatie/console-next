use crate::error::RestError;
use crate::rollout::dto::ConsoleRolloutResponse;
use console_kernel_core::UserId;
use console_platform_db::DbError;
use sqlx::Postgres;
use sqlx::Transaction;

pub(crate) const CONSOLE_ROLLOUT_FLAG_KEY: &str = "console_carbon_copy";
pub(crate) const CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY: &str = "console_legacy_kill_switch";
pub(crate) const CONSOLE_ROLLOUT_USER_FEATURE_KEY: &str = "console_rollout";

pub(crate) async fn fetch_console_rollout_status_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: UserId,
) -> Result<ConsoleRolloutResponse, RestError> {
    let org_enabled: bool = sqlx::query_scalar("SELECT org_runtime_flag_enabled($1)")
        .bind(CONSOLE_ROLLOUT_FLAG_KEY)
        .fetch_one(tx.as_mut())
        .await
        .map_err(DbError::Sqlx)?;
    let legacy_kill_switch_enabled: bool =
        sqlx::query_scalar("SELECT org_runtime_flag_enabled($1)")
            .bind(CONSOLE_LEGACY_KILL_SWITCH_FLAG_KEY)
            .fetch_one(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
    let preferences: Option<serde_json::Value> = sqlx::query_scalar(
        r#"
        SELECT preferences_json
        FROM user_feature_preferences
        WHERE user_id = $1 AND feature_key = $2
        "#,
    )
    .bind(*user_id.as_uuid())
    .bind(CONSOLE_ROLLOUT_USER_FEATURE_KEY)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(DbError::Sqlx)?;
    let user_opted_in = preferences
        .as_ref()
        .and_then(|value| value.get("opt_in"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let effective_new_console = org_enabled && user_opted_in && !legacy_kill_switch_enabled;
    let effective_route_for_opted_in_user = if org_enabled && !legacy_kill_switch_enabled {
        "new_console"
    } else {
        "legacy"
    };
    Ok(ConsoleRolloutResponse {
        flag_key: CONSOLE_ROLLOUT_FLAG_KEY,
        org_enabled,
        org_rollout_enabled: org_enabled,
        user_opted_in,
        legacy_kill_switch_enabled,
        kill_switch_active: legacy_kill_switch_enabled,
        effective_new_console,
        effective_route: if effective_new_console {
            "new_console"
        } else {
            "legacy"
        },
        effective_route_for_opted_in_user,
        effective_route_for_opted_out_user: "legacy",
        overrides_individual_toggles: legacy_kill_switch_enabled,
    })
}

pub(crate) fn normalize_console_rollout_note(
    raw: Option<String>,
) -> Result<Option<String>, RestError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let note = raw.trim().to_owned();
    if note.is_empty() || note.chars().count() > 500 {
        return Err(RestError::validation(
            "rollout_note must be between 1 and 500 characters when provided",
        ));
    }
    Ok(Some(note))
}
