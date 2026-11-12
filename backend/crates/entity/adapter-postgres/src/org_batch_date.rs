// SPDX-License-Identifier: LicenseRef-Proprietary
//! The day a setup batch takes effect: never after today, never before the
//! record it stands on.
use console_entity_domain::Refusal;
use serde_json::Value;
use uuid::Uuid;

use crate::org_tree::Head;
use crate::{PgEntityError, Tx};

/// The batch's day: its own, or today. Setup applies at once, so a change
/// that waits for its day is an org change and is refused here.
pub(crate) fn effective(
    named: Option<time::Date>,
    today: time::Date,
) -> Result<time::Date, PgEntityError> {
    match named {
        Some(date) if date > today => {
            Err(Refusal::field("effective_date", "org_setup_date_future").into())
        }
        Some(date) => Ok(date),
        None => Ok(today),
    }
}

/// A dated write stands on what is already recorded: a change is never
/// before the unit's current record, a unit never before its parent's first.
pub(crate) async fn stands(
    tx: &mut Tx<'_>,
    on: &str,
    current: Option<&Head>,
    attributes: &Value,
) -> Result<(), PgEntityError> {
    if current
        .and_then(|head| head.attributes["effective_from"].as_str())
        .is_some_and(|recorded| recorded > on)
    {
        return Err(Refusal::field("effective_date", "org_setup_date_before_current").into());
    }
    let parent = attributes["parent_id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok());
    if let Some(parent) = parent {
        let first: Option<String> = sqlx::query_scalar(
            "SELECT min(attributes->>'effective_from') FROM org_unit_revisions WHERE org_unit_id = $1",
        )
        .bind(parent)
        .fetch_one(tx.as_mut())
        .await?;
        if first.is_some_and(|first| first.as_str() > on) {
            return Err(Refusal::field("effective_date", "org_setup_date_before_parent").into());
        }
    }
    Ok(())
}
