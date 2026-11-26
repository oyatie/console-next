// SPDX-License-Identifier: LicenseRef-Proprietary
use console_compliance_adapter_postgres::rights::{Kind, Outcome, wire_date};
use console_platform_auth::MobilePasskeyStepUpEnvelope;
use serde::Deserialize;
use time::Date;

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum DecisionKind {
    Access,
    Correction,
    Deletion,
    Suspension,
    Withdrawal,
}

impl From<DecisionKind> for Kind {
    fn from(value: DecisionKind) -> Self {
        match value {
            DecisionKind::Access => Self::Access,
            DecisionKind::Correction => Self::Correction,
            DecisionKind::Deletion => Self::Deletion,
            DecisionKind::Suspension => Self::Suspension,
            DecisionKind::Withdrawal => Self::Withdrawal,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum FinalOutcome {
    Granted,
    Partial,
    Refused,
}

impl From<FinalOutcome> for Outcome {
    fn from(value: FinalOutcome) -> Self {
        match value {
            FinalOutcome::Granted => Self::Granted,
            FinalOutcome::Partial => Self::Partial,
            FinalOutcome::Refused => Self::Refused,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DecideBody {
    pub(super) kind: DecisionKind,
    pub(super) outcome: FinalOutcome,
    #[serde(default)]
    pub(super) reason: Option<String>,
    #[serde(default)]
    pub(super) note: Option<String>,
    #[serde(default, with = "wire_date::option")]
    pub(super) decided_on: Option<Date>,
    pub(super) step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PostponeBody {
    pub(super) kind: DecisionKind,
    pub(super) reason: String,
    pub(super) note: String,
    #[serde(default, with = "wire_date::option")]
    pub(super) decided_on: Option<Date>,
    pub(super) step_up: Option<MobilePasskeyStepUpEnvelope>,
}

#[cfg(test)]
mod tests {
    use super::{DecideBody, PostponeBody};
    use serde_json::{from_value, json};

    #[test]
    fn decisions_accept_filed_rights_and_only_final_outcomes() {
        for kind in [
            "ACCESS",
            "CORRECTION",
            "DELETION",
            "SUSPENSION",
            "WITHDRAWAL",
        ] {
            for outcome in ["GRANTED", "PARTIAL", "REFUSED"] {
                assert!(
                    from_value::<DecideBody>(json!({ "kind": kind, "outcome": outcome })).is_ok()
                );
            }
            assert!(
                from_value::<PostponeBody>(json!({ "kind": kind, "reason": "r", "note": "n" }))
                    .is_ok()
            );
        }
        assert!(
            from_value::<DecideBody>(json!({ "kind": "ACCESS", "outcome": "POSTPONED" })).is_err()
        );
        for kind in ["AUTOMATED_DECISION", "TRANSMISSION"] {
            assert!(
                from_value::<DecideBody>(json!({ "kind": kind, "outcome": "GRANTED" })).is_err()
            );
            assert!(
                from_value::<PostponeBody>(json!({ "kind": kind, "reason": "r", "note": "n" }))
                    .is_err()
            );
        }
    }
}
