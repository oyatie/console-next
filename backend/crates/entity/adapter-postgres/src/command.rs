//! Idempotent entity commands (INTEG-1). Every write carries the request's
//! `Idempotency-Key` as its command id and claims it in `entity_commands`
//! inside its own transaction, before the phase is admitted:
//!
//! * first time: the claim row is inserted and the command runs; `finish`
//!   records what a replay needs (target id, change mode, a count);
//! * same key, same request: the stored outcome is replayed, nothing is
//!   written and no audit event is added;
//! * same key, another request: 409 `idempotency_key_reused`.
//!
//! A concurrent duplicate blocks on the unique key until the first commits
//! (`INSERT … ON CONFLICT DO NOTHING` under READ COMMITTED), then replays.
//! The outcome holds ids and codes only: the response is re-read, so no
//! personal value is copied into the ledger.

use console_entity_application::Actor;
use console_entity_domain::Refusal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{PgEntityError, Tx};

/// What a replay needs to answer as the first run did.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Outcome {
    pub target: Option<Uuid>,
    pub change_mode: Option<String>,
    pub count: Option<i64>,
}

/// The actor's command id, or 422: a write without one is never applied.
pub(crate) fn command_id(actor: &Actor) -> Result<Uuid, PgEntityError> {
    actor
        .command_id
        .ok_or_else(|| Refusal::field("Idempotency-Key", "required").into())
}

/// Claim `actor.command_id` for `action` over `request`. `None`: run the
/// command. `Some(outcome)`: it already ran; replay `outcome`.
pub(crate) async fn claim(
    tx: &mut Tx<'_>,
    actor: &Actor,
    action: &'static str,
    request: Value,
) -> Result<Option<Outcome>, PgEntityError> {
    let id = command_id(actor)?;
    let digest = json!({ "action": action, "request": request });
    let inserted = sqlx::query(
        "INSERT INTO entity_commands (org_id, command_id, action, request_digest, actor_id) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::uuid, $1, $2, \
                 sha256(convert_to($3::jsonb::text, 'UTF8')), $4) \
         ON CONFLICT (org_id, command_id) DO NOTHING",
    )
    .bind(id)
    .bind(action)
    .bind(&digest)
    .bind(*actor.user.as_uuid())
    .execute(tx.as_mut())
    .await?
    .rows_affected();
    if inserted == 1 {
        return Ok(None);
    }
    let (same, outcome): (bool, Value) = sqlx::query_as(
        "SELECT action = $2 AND request_digest = sha256(convert_to($3::jsonb::text, 'UTF8')), outcome \
         FROM entity_commands WHERE command_id = $1",
    )
    .bind(id)
    .bind(action)
    .bind(&digest)
    .fetch_one(tx.as_mut())
    .await?;
    if !same {
        return Err(Refusal::conflict(
            "idempotency_key_reused",
            "this Idempotency-Key was already used for a different request",
        )
        .with_remedy("retry_with_new_key")
        .into());
    }
    let outcome: Outcome = serde_json::from_value(outcome)?;
    let kind = action.split('.').next().unwrap_or("command_outcome");
    let target = outcome.target.map(|id| id.to_string());
    console_platform_db::idempotency::record_legacy_replay(tx, kind, target.as_deref(), None)
        .await?;
    Ok(Some(outcome))
}

/// Record the outcome of a command that ran (same transaction as its writes).
pub(crate) async fn finish(
    tx: &mut Tx<'_>,
    actor: &Actor,
    outcome: &Outcome,
) -> Result<(), PgEntityError> {
    sqlx::query("UPDATE entity_commands SET outcome = $2 WHERE command_id = $1")
        .bind(command_id(actor)?)
        .bind(serde_json::to_value(outcome)?)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}
