//! `Idempotency-Key` reservations for create endpoints (`api_idempotency_keys`,
//! migration 0243).
//!
//! Same shape as the employee-create reservation: `INSERT .. ON CONFLICT DO
//! NOTHING` then `SELECT .. FOR UPDATE` in the caller's transaction, so a
//! concurrent same-key request waits on the row and then replays the committed
//! response. A failed create rolls the reservation back with it.

mod replay;
pub use replay::record as record_legacy_replay;
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};

pub const IDEMPOTENCY_KEY_HEADER: &str = "Idempotency-Key";
pub const IDEMPOTENCY_KEY_REQUIRED: &str = "Idempotency-Key header is required";
pub const IDEMPOTENCY_KEY_LENGTH: &str = "Idempotency-Key must be 16..200 characters";
pub const IDEMPOTENCY_KEY_REUSED: &str = "idempotency key was reused with a different request";

/// The trimmed key, or the message of the 422 to return. Characters, not bytes:
/// the DB CHECK is `char_length`.
pub fn validate_idempotency_key(raw: Option<&str>) -> Result<String, &'static str> {
    let key = raw.map(str::trim).ok_or(IDEMPOTENCY_KEY_REQUIRED)?;
    if (16..=200).contains(&key.chars().count()) {
        Ok(key.to_owned())
    } else {
        Err(IDEMPOTENCY_KEY_LENGTH)
    }
}

#[derive(Debug)]
pub enum IdempotencyClaim {
    /// First use: run the create, then [`complete_idempotency_key`].
    Fresh,
    /// Exact replay: return this stored response (HTTP 200).
    Replay(Value),
    /// Same key, different request: 409 [`IDEMPOTENCY_KEY_REUSED`].
    Mismatch,
}

/// Reserve `key` for `operation` in the transaction's tenant (`app.current_org`
/// must already be armed). `request` is the canonical request; its SHA-256 is
/// the fingerprint.
pub async fn claim_idempotency_key(
    tx: &mut Transaction<'_, Postgres>,
    operation: &str,
    key: &str,
    request: &Value,
) -> Result<IdempotencyClaim, sqlx::Error> {
    let request_text = request.to_string();
    sqlx::query(
        "INSERT INTO api_idempotency_keys (org_id, operation, idempotency_key, request_fingerprint) \
         VALUES (NULLIF(current_setting('app.current_org', true), '')::UUID, $1, $2, \
                 encode(sha256(convert_to($3, 'UTF8')), 'hex')) \
         ON CONFLICT (org_id, operation, idempotency_key) DO NOTHING",
    )
    .bind(operation)
    .bind(key)
    .bind(&request_text)
    .execute(tx.as_mut())
    .await?;
    let row = sqlx::query(
        "SELECT request_fingerprint = encode(sha256(convert_to($3, 'UTF8')), 'hex') AS same, response \
         FROM api_idempotency_keys \
         WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::UUID \
           AND operation = $1 AND idempotency_key = $2 \
         FOR UPDATE",
    )
    .bind(operation)
    .bind(key)
    .bind(&request_text)
    .fetch_one(tx.as_mut())
    .await?;
    let same: bool = row.try_get("same")?;
    let response: Option<Value> = row.try_get("response")?;
    if let (true, Some(response)) = (same, &response) {
        replay::settle(tx, operation, request, response).await?;
    }
    Ok(match (same, response) {
        (false, _) => IdempotencyClaim::Mismatch,
        (true, Some(response)) => IdempotencyClaim::Replay(response),
        (true, None) => IdempotencyClaim::Fresh,
    })
}

/// Store the response an exact replay of `key` returns.
pub async fn complete_idempotency_key(
    tx: &mut Transaction<'_, Postgres>,
    operation: &str,
    key: &str,
    response: &Value,
) -> Result<(), sqlx::Error> {
    crate::command_outcomes::set_result(tx, response)
        .await
        .map_err(|error| match error {
            crate::DbError::Sqlx(error) => error,
            _ => sqlx::Error::Protocol("command result serialization failed".into()),
        })?;
    sqlx::query(
        "UPDATE api_idempotency_keys SET response = $3, completed_at = now() \
         WHERE org_id = NULLIF(current_setting('app.current_org', true), '')::UUID \
           AND operation = $1 AND idempotency_key = $2",
    )
    .bind(operation)
    .bind(key)
    .bind(response)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}
