// SPDX-License-Identifier: LicenseRef-Proprietary
//! Approval evidence shared by inbox sources; commands recheck live facts.
use console_kernel_core::KernelError;
use console_settings_domain::SettingKey;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DecisionPolicy {
    pub key: SettingKey,
    pub routed: bool,
    pub merge_consecutive: bool,
    pub bulk_allowed: bool,
    pub step_up: bool,
}

impl DecisionPolicy {
    #[must_use]
    pub fn routed(
        key: SettingKey,
        routed: bool,
        bulk_allowed: bool,
        step_up: bool,
    ) -> Option<Self> {
        routed.then_some(Self {
            key,
            routed,
            // Distinct people decide stored steps; merging is never an approval policy option.
            merge_consecutive: false,
            bulk_allowed,
            step_up,
        })
    }
}

#[derive(Debug, Serialize)]
pub struct DecisionFacts {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<DecisionPolicy>,
    pub can_decide: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cannot_reason: Option<&'static str>,
}

impl DecisionFacts {
    #[must_use]
    pub fn new(
        version: String,
        policy: Option<DecisionPolicy>,
        decision: Result<(), KernelError>,
    ) -> Self {
        Self {
            version,
            policy,
            can_decide: decision.is_ok(),
            cannot_reason: decision
                .err()
                .map(|error| error.code.unwrap_or("forbidden")),
        }
    }
}
