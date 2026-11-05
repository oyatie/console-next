// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{Kind, Outcome};

impl Kind {
    /// Wire domains are identifiers; the settings code_lists roster owns their codes.
    pub fn reason_domain(self, outcome: Outcome) -> Option<&'static str> {
        match (self, outcome) {
            (Self::Access, Outcome::Postponed) => Some("privacy_postpone_access"),
            (_, Outcome::Granted | Outcome::Postponed) => None,
            (Self::Access, _) => Some("privacy_refusal_access"),
            (Self::Deletion, _) => Some("privacy_refusal_deletion"),
            (Self::Suspension | Self::Withdrawal, _) => Some("privacy_refusal_suspension"),
            _ => None,
        }
    }
}
