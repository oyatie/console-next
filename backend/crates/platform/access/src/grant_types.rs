//! A grant operation as sent, and as previewed (defaults filled, new grant
//! ids assigned) so apply writes exactly what the receipt names.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::dto::{ScopeIn, StepUp};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum OpIn {
    Grant {
        account_id: Uuid,
        role_id: Uuid,
        scope: ScopeIn,
        #[serde(default, with = "time::serde::rfc3339::option")]
        valid_from: Option<OffsetDateTime>,
        #[serde(default, with = "time::serde::rfc3339::option")]
        valid_to: Option<OffsetDateTime>,
        #[serde(default)]
        effective_in_setup: bool,
    },
    Revoke {
        grant_id: Uuid,
    },
    SetEnd {
        grant_id: Uuid,
        #[serde(with = "time::serde::rfc3339::option")]
        valid_to: Option<OffsetDateTime>,
    },
}

/// The batch as previewed: defaults filled, so apply writes exactly this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum Op {
    Grant {
        grant_id: Uuid,
        account_id: Uuid,
        role_id: Uuid,
        scope: ScopeIn,
        #[serde(with = "time::serde::rfc3339")]
        valid_from: OffsetDateTime,
        #[serde(with = "time::serde::rfc3339::option")]
        valid_to: Option<OffsetDateTime>,
        effective_in_setup: bool,
    },
    Revoke {
        grant_id: Uuid,
    },
    SetEnd {
        grant_id: Uuid,
        #[serde(with = "time::serde::rfc3339::option")]
        valid_to: Option<OffsetDateTime>,
    },
}

impl Op {
    pub(crate) fn normalize(op: OpIn, now: OffsetDateTime) -> Self {
        match op {
            OpIn::Grant {
                account_id,
                role_id,
                scope,
                valid_from,
                valid_to,
                effective_in_setup,
            } => Self::Grant {
                grant_id: Uuid::new_v4(),
                account_id,
                role_id,
                scope,
                valid_from: valid_from.unwrap_or(now),
                valid_to,
                effective_in_setup,
            },
            OpIn::Revoke { grant_id } => Self::Revoke { grant_id },
            OpIn::SetEnd { grant_id, valid_to } => Self::SetEnd { grant_id, valid_to },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    pub(crate) operations: Vec<OpIn>,
    pub(crate) reason_code: String,
    #[serde(default)]
    pub(crate) reason_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Apply {
    pub(crate) receipt_id: Uuid,
    #[serde(default)]
    pub(crate) step_up: Option<StepUp>,
}

#[derive(Debug, Deserialize)]
pub struct GrantQuery {
    pub(crate) account_id: Option<Uuid>,
    pub(crate) role_id: Option<Uuid>,
    #[serde(default)]
    pub(crate) include_ended: bool,
}
