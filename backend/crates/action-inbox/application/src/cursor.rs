//! Immutable action-inbox cursor encoding and validation.

use super::namespaced_id::valid_namespaced_id;
use console_kernel_core::KernelError;
use time::OffsetDateTime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxPosition {
    pub created_at: OffsetDateTime,
    pub due: Option<OffsetDateTime>,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionInboxCursor {
    pub as_of: OffsetDateTime,
    pub position: ActionInboxPosition,
}

pub fn encode_cursor(as_of: OffsetDateTime, position: &ActionInboxPosition) -> String {
    format!(
        "v2~{}~{}~{}~{}",
        as_of.unix_timestamp_nanos(),
        position.due.map_or_else(
            || "none".into(),
            |due| due.unix_timestamp_nanos().to_string()
        ),
        position.created_at.unix_timestamp_nanos(),
        position.id
    )
}

pub fn parse_cursor(raw: &str, now: OffsetDateTime) -> Result<ActionInboxCursor, KernelError> {
    let mut parts = raw.splitn(5, '~');
    let version = parts.next();
    let as_of = parse_timestamp(parts.next());
    let due = parts.next().and_then(|value| {
        if value == "none" {
            Some(None)
        } else {
            parse_timestamp(Some(value)).map(Some)
        }
    });
    let created_at = parse_timestamp(parts.next());
    let id = parts.next().filter(|value| !value.is_empty());
    match (version, as_of, due, created_at, id) {
        (Some("v2"), Some(as_of), Some(due), Some(created_at), Some(id))
            if as_of <= now && created_at <= as_of && valid_namespaced_id(id) =>
        {
            Ok(ActionInboxCursor {
                as_of,
                position: ActionInboxPosition {
                    due,
                    created_at,
                    id: id.to_owned(),
                },
            })
        }
        _ => Err(KernelError::validation("invalid action-inbox cursor")),
    }
}

fn parse_timestamp(raw: Option<&str>) -> Option<OffsetDateTime> {
    raw.and_then(|value| value.parse::<i128>().ok())
        .and_then(|value| OffsetDateTime::from_unix_timestamp_nanos(value).ok())
}
