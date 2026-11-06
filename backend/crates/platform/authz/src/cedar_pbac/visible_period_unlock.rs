// SPDX-License-Identifier: LicenseRef-Proprietary
use super::DecisionFacts;
use console_kernel_core::OrgId;
use uuid::Uuid;

impl DecisionFacts {
    /// Count only this active account's governed period-unlock notices.
    pub fn authorize_period_unlock_notice_count(
        &self,
        org: OrgId,
        recipient: Uuid,
    ) -> Result<bool, String> {
        crate::cedar_pbac::actions::period_unlock_notice_count::decide(
            &self.actor.to_string(),
            &self.org.to_string(),
            &org.to_string(),
            self.actor == recipient,
        )
    }
}
