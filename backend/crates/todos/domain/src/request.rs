// SPDX-License-Identifier: LicenseRef-Proprietary
//! Requests: a todo one account asks another to do. A request moves forward
//! only: open, then done or returned. Its links name records by kind and id
//! and never carry a label, which would be a second free-text channel every
//! assignee reads whatever they may see of the record.

use console_kernel_core::{KernelError, UserId};
use serde::Deserialize;
use time::Date;

use crate::{REFS_MAX, TodoRef};

const RETURN_NOTE_MAX: usize = 200;

/// Record kinds the work inbox opens from a single id.
pub const REQUEST_LINK_KINDS: &[&str] = &[
    "change_request",
    "employee",
    "exit_case",
    "identifier_correction",
    "org_change",
    "period_lock",
    "privacy_request",
    "statutory",
    "support_session",
];

/// One record a request points at. A sent label is ignored, never stored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RequestLink {
    pub kind: String,
    pub id: String,
}

/// Where a request stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestState {
    Open,
    Done,
    Returned,
}

impl RequestState {
    #[must_use]
    pub fn of(done: bool, returned: bool) -> Self {
        match (done, returned) {
            (true, _) => Self::Done,
            (false, true) => Self::Returned,
            (false, false) => Self::Open,
        }
    }

    /// The `state` filter of the requester's list.
    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "open" => Ok(Self::Open),
            "done" => Ok(Self::Done),
            "returned" => Ok(Self::Returned),
            _ => Err(
                KernelError::validation("state must be open, done or returned").with_field("state"),
            ),
        }
    }

    /// Return and withdraw act on an open request only.
    pub fn ensure_open(self) -> Result<(), KernelError> {
        if self == Self::Open {
            Ok(())
        } else {
            Err(closed())
        }
    }

    /// Done again is a no-op; reopening or finishing a returned request is refused.
    pub fn ensure_done_allowed(self, done: bool) -> Result<(), KernelError> {
        match (self, done) {
            (Self::Open, _) | (Self::Done, true) => Ok(()),
            _ => Err(closed()),
        }
    }
}

/// Asking yourself is a private todo, not a request.
pub fn ensure_not_self(requester: UserId, assignee: UserId) -> Result<(), KernelError> {
    if requester == assignee {
        return Err(KernelError::validation(
            "a request goes to someone else; add your own todo instead",
        )
        .with_code("todo_assign_self")
        .with_field("assignee_account_id"));
    }
    Ok(())
}

/// A due date may be today or later in the house calendar (KST).
pub fn ensure_due(due_on: Option<Date>, today: Date) -> Result<(), KernelError> {
    if due_on.is_some_and(|due| due < today) {
        return Err(
            KernelError::validation("due_on must be today or later (KST)")
                .with_code("todo_due_past")
                .with_field("due_on"),
        );
    }
    Ok(())
}

/// The line the owner writes when sending a request back.
pub fn return_note(value: String) -> Result<String, KernelError> {
    let note = value.trim();
    if note.is_empty() || note.chars().count() > RETURN_NOTE_MAX {
        return Err(KernelError::validation(format!(
            "note must be 1..={RETURN_NOTE_MAX} characters"
        ))
        .with_field("note"));
    }
    Ok(note.to_owned())
}

/// Validates a request's links into stored refs without labels.
pub fn request_links(links: Vec<RequestLink>) -> Result<Vec<TodoRef>, KernelError> {
    if links.len() > REFS_MAX {
        return Err(KernelError::validation(format!(
            "links must contain at most {REFS_MAX} entries"
        ))
        .with_field("links"));
    }
    links
        .into_iter()
        .map(|link| {
            let kind = link.kind.trim();
            if !REQUEST_LINK_KINDS.contains(&kind) {
                return Err(
                    KernelError::validation("link kind is not a record kind").with_field("links")
                );
            }
            let id = uuid::Uuid::parse_str(link.id.trim()).map_err(|_| {
                KernelError::validation("link id must be a UUID").with_field("links")
            })?;
            Ok(TodoRef {
                kind: kind.to_owned(),
                id: id.to_string(),
                label: None,
            })
        })
        .collect()
}

fn closed() -> KernelError {
    KernelError::conflict("the request is already done or returned").with_code("todo_closed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::ErrorKind;
    use time::macros::date;

    fn link(kind: &str, id: &str) -> RequestLink {
        RequestLink {
            kind: kind.into(),
            id: id.into(),
        }
    }

    #[test]
    fn a_request_moves_forward_only() {
        assert_eq!(RequestState::of(false, false), RequestState::Open);
        assert_eq!(RequestState::of(true, false), RequestState::Done);
        assert_eq!(RequestState::of(false, true), RequestState::Returned);
        assert!(RequestState::Open.ensure_open().is_ok());
        for closed in [RequestState::Done, RequestState::Returned] {
            let err = closed.ensure_open().unwrap_err();
            assert_eq!(
                (err.kind, err.code),
                (ErrorKind::Conflict, Some("todo_closed"))
            );
        }
        assert!(RequestState::Open.ensure_done_allowed(true).is_ok());
        assert!(RequestState::Open.ensure_done_allowed(false).is_ok());
        assert!(RequestState::Done.ensure_done_allowed(true).is_ok());
        for (state, done) in [
            (RequestState::Done, false),
            (RequestState::Returned, true),
            (RequestState::Returned, false),
        ] {
            let err = state.ensure_done_allowed(done).unwrap_err();
            assert_eq!(err.code, Some("todo_closed"), "{state:?} done={done}");
        }
    }

    #[test]
    fn the_list_filter_reads_three_states() {
        assert_eq!(RequestState::parse("open").unwrap(), RequestState::Open);
        assert_eq!(RequestState::parse("done").unwrap(), RequestState::Done);
        assert_eq!(
            RequestState::parse("returned").unwrap(),
            RequestState::Returned
        );
        let err = RequestState::parse("withdrawn").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Validation);
    }

    #[test]
    fn asking_yourself_is_refused() {
        let me = UserId::new();
        let err = ensure_not_self(me, me).unwrap_err();
        assert_eq!(
            (err.kind, err.code),
            (ErrorKind::Validation, Some("todo_assign_self"))
        );
        assert!(ensure_not_self(me, UserId::new()).is_ok());
    }

    #[test]
    fn a_due_date_is_today_or_later() {
        let today = date!(2026 - 11 - 13);
        assert!(ensure_due(None, today).is_ok());
        assert!(ensure_due(Some(today), today).is_ok());
        assert!(ensure_due(Some(date!(2026 - 11 - 14)), today).is_ok());
        let err = ensure_due(Some(date!(2026 - 11 - 12)), today).unwrap_err();
        assert_eq!(
            (err.kind, err.code),
            (ErrorKind::Validation, Some("todo_due_past"))
        );
    }

    #[test]
    fn the_return_note_is_one_short_line() {
        assert_eq!(return_note("  할 수 없음 ".into()).unwrap(), "할 수 없음");
        assert!(return_note("   ".into()).is_err());
        assert!(return_note("x".repeat(RETURN_NOTE_MAX + 1)).is_err());
        assert!(return_note("x".repeat(RETURN_NOTE_MAX)).is_ok());
    }

    #[test]
    fn links_name_records_by_uuid_and_store_no_label() {
        let id = "6f1c3e2a-0b4d-4f6e-9a8b-7c6d5e4f3a2b";
        let refs = request_links(vec![link(" employee ", id)]).unwrap();
        assert_eq!(
            refs,
            vec![TodoRef {
                kind: "employee".into(),
                id: id.into(),
                label: None
            }]
        );
        for bad in [
            link("workOrder", id),
            link("employee", "E-1024"),
            link("registration_check", id),
        ] {
            let err = request_links(vec![bad]).unwrap_err();
            assert_eq!(err.kind, ErrorKind::Validation);
        }
        let too_many = (0..=REFS_MAX).map(|_| link("employee", id)).collect();
        assert!(request_links(too_many).is_err());
    }

    #[test]
    fn a_sent_label_is_dropped_on_read() {
        let sent: RequestLink =
            serde_json::from_str(r#"{"kind":"employee","id":"x","label":"free text"}"#).unwrap();
        assert_eq!(sent, link("employee", "x"));
    }
}
