// SPDX-License-Identifier: LicenseRef-Proprietary
//! Recovery transitions, independent of storage and authorization.
use crate::ProvisioningError;
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OpsRecoveryState {
    WaitingApproval,
    Hold,
    Ready,
    Issued,
    Cancelled,
}

pub fn recovery_state(
    hold: Option<OffsetDateTime>,
    cancelled: bool,
    issued: bool,
    now: OffsetDateTime,
) -> OpsRecoveryState {
    if cancelled {
        OpsRecoveryState::Cancelled
    } else if issued {
        OpsRecoveryState::Issued
    } else {
        match hold {
            None => OpsRecoveryState::WaitingApproval,
            Some(until) if now < until => OpsRecoveryState::Hold,
            Some(_) => OpsRecoveryState::Ready,
        }
    }
}

pub fn require_issue(state: OpsRecoveryState) -> Result<(), ProvisioningError> {
    match state {
        OpsRecoveryState::Ready => Ok(()),
        OpsRecoveryState::Cancelled => {
            Err(ProvisioningError::OpsRecovery("ops_recovery_cancelled"))
        }
        OpsRecoveryState::Hold => Err(ProvisioningError::OpsRecovery("ops_recovery_hold_active")),
        OpsRecoveryState::WaitingApproval => {
            Err(ProvisioningError::OpsRecovery("ops_recovery_not_approved"))
        }
        OpsRecoveryState::Issued => Err(ProvisioningError::Conflict(
            "recovery code already issued".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_wins_and_hold_ends_at_the_boundary() {
        let now = OffsetDateTime::UNIX_EPOCH;
        assert_eq!(
            recovery_state(Some(now), false, false, now),
            OpsRecoveryState::Ready
        );
        assert_eq!(
            recovery_state(Some(now), false, false, now - time::Duration::seconds(1)),
            OpsRecoveryState::Hold
        );
        assert_eq!(
            recovery_state(Some(now), true, false, now),
            OpsRecoveryState::Cancelled
        );
        for (state, code) in [
            (OpsRecoveryState::Cancelled, "ops_recovery_cancelled"),
            (OpsRecoveryState::Hold, "ops_recovery_hold_active"),
            (
                OpsRecoveryState::WaitingApproval,
                "ops_recovery_not_approved",
            ),
        ] {
            assert!(
                matches!(require_issue(state), Err(ProvisioningError::OpsRecovery(c)) if c==code)
            );
        }
        assert!(require_issue(OpsRecoveryState::Issued).is_err());
        assert!(require_issue(OpsRecoveryState::Ready).is_ok());
    }
}
