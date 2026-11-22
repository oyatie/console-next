// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::UtcTimestamp;
use console_ops_domain::changes::{Dora5Metrics, GateStatement};
use console_ops_domain::ladders::EvidenceState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use time::OffsetDateTime;

use crate::obligations::Error as SpoolError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseArtifact {
    pub digest: String,
    pub gates: Option<GateStatement>,
    pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeployHistoryEntry {
    pub at: UtcTimestamp,
    pub result: String,
    pub from_digest: Option<String>,
    pub to_digest: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigHistoryEntry {
    pub at: UtcTimestamp,
    pub result: String,
    pub sha: String,
    pub message: String,
}

pub trait ReleasesStore: Send + Sync {
    fn list_releases(&self) -> Result<Vec<ReleaseArtifact>, String>;
    fn get_gates(&self, digest: &str) -> Result<Option<GateStatement>, String>;
}

pub trait HostStateStore: Send + Sync {
    fn read_deploy_history(&self) -> Option<Vec<DeployHistoryEntry>>;
    fn read_config_history(&self) -> Option<Vec<ConfigHistoryEntry>>;
    fn read_rollout(&self) -> Option<Value>;
    fn read_desired(&self) -> Option<Value>;
    fn read_completed_requests(&self) -> Option<Vec<String>>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReleaseGateView {
    pub digest: String,
    pub state: EvidenceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gates: Option<GateStatement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChangesTimelineItem {
    pub at: UtcTimestamp,
    pub kind: String,
    pub summary: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChangesView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub releases: Vec<ReleaseGateView>,
    pub timeline: Vec<ChangesTimelineItem>,
    pub dora5: Dora5Metrics,
    pub freeze: console_ops_domain::Observed<bool>,
    pub canary_percent: console_ops_domain::Observed<f64>,
    pub bundle_sha: console_ops_domain::Observed<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanaryDecision {
    Hold,
    Promote,
    Abort,
}

impl CanaryDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hold => "hold",
            Self::Promote => "promote",
            Self::Abort => "abort",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangeError {
    InvalidInput(String),
    Spool(SpoolError),
}

impl From<SpoolError> for ChangeError {
    fn from(value: SpoolError) -> Self {
        Self::Spool(value)
    }
}

pub use crate::changes_service::ChangesService;
