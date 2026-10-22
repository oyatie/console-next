// SPDX-License-Identifier: LicenseRef-Proprietary
//! Which recovery a revoked refresh family points the person to (fin-session-recovery):
//! the stored revocation reason picks the refusal the client turns into its next step.

use super::RefreshTokenUseError;

impl RefreshTokenUseError {
    pub(super) fn revoked(reason: Option<&str>) -> Self {
        match reason {
            Some(crate::idle::IDLE_TIMEOUT_REASON) => Self::IdleExpired,
            Some("credential_reset") => Self::PasskeyReset,
            Some("user_deactivated" | "employee_exit") => Self::AccountDeactivated,
            Some("logout") => Self::SignedOutElsewhere,
            _ => Self::FamilyRevoked,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RefreshTokenUseError as E;

    #[test]
    fn revocation_keeps_the_recovery_reason() {
        for (reason, expected) in [
            (Some(crate::idle::IDLE_TIMEOUT_REASON), E::IdleExpired),
            (Some("credential_reset"), E::PasskeyReset),
            (Some("user_deactivated"), E::AccountDeactivated),
            (Some("employee_exit"), E::AccountDeactivated),
            (Some("ops_holder_exit"), E::FamilyRevoked),
            (Some("logout"), E::SignedOutElsewhere),
            (Some("reuse_detected"), E::FamilyRevoked),
            (None, E::FamilyRevoked),
        ] {
            assert_eq!(E::revoked(reason), expected);
        }
    }
}
