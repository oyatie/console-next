// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{AgentKind, Channel, Controller, IdentityMethod, Kind, Outcome, wire_date};

use serde::{Deserialize, Serialize};
use time::Date;
use uuid::Uuid;

/// Self-service filing; the server supplies subject, channel, identity and receipt date.
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Filing {
    pub controller: Controller,
    pub kinds: Vec<Kind>,
    #[serde(default)]
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OffAppController {
    Tenant,
}

impl From<OffAppController> for Controller {
    fn from(value: OffAppController) -> Self {
        match value {
            OffAppController::Tenant => Self::Tenant,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OffAppChannel {
    Phone,
    Letter,
    Email,
    InPerson,
}

impl From<OffAppChannel> for Channel {
    fn from(value: OffAppChannel) -> Self {
        match value {
            OffAppChannel::Phone => Self::Phone,
            OffAppChannel::Letter => Self::Letter,
            OffAppChannel::Email => Self::Email,
            OffAppChannel::InPerson => Self::InPerson,
        }
    }
}

/// Off-app intake recorded by an authorized privacy handler.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OffAppReceipt {
    pub subject_user_id: Uuid,
    pub controller: OffAppController,
    pub channel: OffAppChannel,
    pub agent: AgentKind,
    #[serde(default)]
    pub mandate_received: bool,
    pub identity_method: IdentityMethod,
    #[serde(with = "wire_date")]
    pub received_on: Date,
    pub kinds: Vec<Kind>,
    #[serde(default)]
    pub detail: String,
}

/// Decision payload bound by passkey step-up (`PRIVACY_REQUEST_DECIDE`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DecideInput {
    pub kind: Kind,
    pub outcome: Outcome,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default, with = "wire_date::option")]
    pub decided_on: Option<Date>,
}

/// Postponement payload bound by passkey step-up (`PRIVACY_REQUEST_DECIDE`).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PostponeInput {
    pub kind: Kind,
    pub reason: String,
    pub note: String,
    #[serde(default, with = "wire_date::option")]
    pub decided_on: Option<Date>,
}

/// Objection intake against a prior request decision.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectionInput {
    pub kinds: Vec<Kind>,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub channel: Option<Channel>,
    #[serde(default)]
    pub agent: Option<AgentKind>,
    #[serde(default)]
    pub mandate_received: bool,
    #[serde(default)]
    pub identity_method: Option<IdentityMethod>,
    #[serde(default, with = "wire_date::option")]
    pub received_on: Option<Date>,
}

impl Kind {
    // Automated decisions and transmission have no supported filing register yet.
    pub const FILING: &[Self] = &[
        Self::Access,
        Self::Correction,
        Self::Deletion,
        Self::Suspension,
        Self::Withdrawal,
    ];
}

#[cfg(test)]
mod tests {
    use super::OffAppReceipt;
    use serde_json::{from_value, json};

    #[test]
    fn off_app_receipt_accepts_only_tenant_and_off_app_channels() {
        let mut body = json!({
            "subject_user_id": "00000000-0000-0000-0000-000000000001",
            "controller": "TENANT", "channel": "PHONE", "agent": "SUBJECT",
            "identity_method": "KNOWN_CONTACT", "received_on": "2026-11-01", "kinds": ["ACCESS"]
        });
        for channel in ["PHONE", "LETTER", "EMAIL", "IN_PERSON"] {
            body["channel"] = json!(channel);
            assert!(
                from_value::<OffAppReceipt>(body.clone()).is_ok(),
                "{channel}"
            );
        }
        body["channel"] = json!("IN_APP");
        assert!(from_value::<OffAppReceipt>(body.clone()).is_err());
        body["channel"] = json!("PHONE");
        body["controller"] = json!("OPERATOR");
        assert!(from_value::<OffAppReceipt>(body).is_err());
    }
}
