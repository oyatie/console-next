// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::UtcTimestamp;
use console_ops_domain::changes::CmdHandOff;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::obligations::{Context, Error as SpoolError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionRecord {
    pub seq: u64,
    pub hash: String,
    pub support_ref: String,
    pub at: UtcTimestamp,
    pub operator: String,
    pub status: ActionStatus,
    #[serde(flatten)]
    pub handoff: CmdHandOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    Pending,
    Executed,
    Superseded,
}

#[derive(Debug, Clone, Copy)]
pub struct CmdHandOffInput<'a> {
    pub kind: &'a str,
    pub command: &'a str,
    pub target: &'a str,
    pub consequence: &'a str,
    pub expected_result: &'a str,
    pub verify_step: &'a str,
}

pub trait ActionStore: Send + Sync {
    fn list_actions(&self) -> Result<Vec<ActionRecord>, SpoolError>;
    fn record_handoff(
        &self,
        input: &CmdHandOffInput<'_>,
        context: &Context,
    ) -> Result<ActionRecord, SpoolError>;
}

pub struct ActionService<'a> {
    store: &'a dyn ActionStore,
}

impl<'a> ActionService<'a> {
    pub fn new(store: &'a dyn ActionStore) -> Self {
        Self { store }
    }

    pub fn list(&self) -> Result<Vec<ActionRecord>, SpoolError> {
        self.store.list_actions()
    }

    pub fn pending(&self) -> Result<Vec<ActionRecord>, SpoolError> {
        Ok(self
            .store
            .list_actions()?
            .into_iter()
            .filter(|a| a.status == ActionStatus::Pending)
            .collect())
    }

    pub fn record_cmd(
        &self,
        input: &CmdHandOffInput<'_>,
        context: &Context,
    ) -> Result<ActionRecord, SpoolError> {
        self.store.record_handoff(input, context)
    }
}

pub fn new_action_id(seq: u64) -> String {
    format!("ACT-{seq:04}")
}

pub fn validate_non_empty(raw: &str) -> bool {
    let trimmed = raw.trim();
    !trimmed.is_empty() && !trimmed.chars().any(char::is_control)
}

pub fn format_utc_z(ts: OffsetDateTime) -> UtcTimestamp {
    UtcTimestamp::new(ts)
}

pub fn parse_compact_utc(raw: &str) -> Option<UtcTimestamp> {
    let desc = time::macros::format_description!("[year][month][day]T[hour][minute][second]Z");
    let pdt = time::PrimitiveDateTime::parse(raw, &desc).ok()?;
    OffsetDateTime::from_unix_timestamp(pdt.assume_utc().unix_timestamp())
        .ok()
        .map(UtcTimestamp::new)
}
