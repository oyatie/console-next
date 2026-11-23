// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::UtcTimestamp;
use crate::ladders::{Incident, PublicComponent};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusComponentState {
    Ok,
    Unknown,
    Maint,
    Degraded,
    Partial,
    Major,
}

impl From<StatusComponentState> for PublicComponent {
    fn from(value: StatusComponentState) -> Self {
        match value {
            StatusComponentState::Ok => Self::Operational,
            StatusComponentState::Unknown => Self::Unknown,
            StatusComponentState::Maint => Self::Maintenance,
            StatusComponentState::Degraded => Self::DegradedPerformance,
            StatusComponentState::Partial => Self::PartialOutage,
            StatusComponentState::Major => Self::MajorOutage,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusPublicText {
    pub ko: String,
    pub en: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusEvidenceSample {
    pub at: UtcTimestamp,
    pub components: BTreeMap<String, StatusComponentState>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub vantage: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusEvidence {
    pub schema: u32,
    pub samples: Vec<StatusEvidenceSample>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusStage {
    Investigating,
    Identified,
    Monitoring,
    Resolved,
}

impl From<StatusStage> for Incident {
    fn from(value: StatusStage) -> Self {
        match value {
            StatusStage::Investigating => Self::Investigating,
            StatusStage::Identified => Self::Identified,
            StatusStage::Monitoring => Self::Monitoring,
            StatusStage::Resolved => Self::Resolved,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusIncidentUpdate {
    pub n: u64,
    pub at: UtcTimestamp,
    pub text: StatusPublicText,
    pub stage: StatusStage,
    pub components: BTreeMap<String, StatusComponentState>,
    pub next_update_by: Option<UtcTimestamp>,
    pub correction_of: Option<u64>,
    #[serde(default)]
    pub blocks: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusIncident {
    pub id: String,
    pub title: StatusPublicText,
    pub started_at: UtcTimestamp,
    pub report_url: Option<String>,
    pub updates: Vec<StatusIncidentUpdate>,
    #[serde(default)]
    pub retroactive: Option<bool>,
    #[serde(default)]
    pub resolution: Option<serde_json::Value>,
    #[serde(default)]
    pub detected_at: Option<UtcTimestamp>,
    #[serde(default)]
    pub report_due: Option<UtcTimestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusV2Snapshot {
    #[serde(rename = "$schema", default)]
    pub schema_uri: Option<String>,
    pub schema: u32,
    pub rev: u64,
    pub generated_at: UtcTimestamp,
    pub record_start: UtcTimestamp,
    pub evidence: StatusEvidence,
    pub incidents: Vec<StatusIncident>,
    pub maintenances: Vec<serde_json::Value>,
    #[serde(default)]
    pub vantage_counts: Option<BTreeMap<String, u64>>,
    #[serde(default)]
    pub postmortems: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusParseError(pub String);

impl std::fmt::Display for StatusParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StatusParseError {}

fn is_valid_st_id(id: &str) -> bool {
    let Some(digits) = id.strip_prefix("ST-") else {
        return false;
    };
    digits.len() >= 4 && digits.bytes().all(|b| b.is_ascii_digit())
}

pub fn parse_status_v2_json(raw: &str) -> Result<StatusV2Snapshot, StatusParseError> {
    let snap: StatusV2Snapshot = serde_json::from_str(raw)
        .map_err(|e| StatusParseError(format!("invalid status.v2.json: {e}")))?;
    if snap.schema != 2 {
        return Err(StatusParseError(
            "status.v2.json schema must be 2".to_owned(),
        ));
    }
    if snap.rev < 1 {
        return Err(StatusParseError(
            "status.v2.json rev must be >= 1".to_owned(),
        ));
    }
    if snap.evidence.schema != 1 {
        return Err(StatusParseError(
            "status.v2.json evidence.schema must be 1".to_owned(),
        ));
    }
    for inc in &snap.incidents {
        if !is_valid_st_id(&inc.id) {
            return Err(StatusParseError(format!("invalid incident id {}", inc.id)));
        }
        if inc.title.ko.trim().is_empty() || inc.updates.is_empty() {
            return Err(StatusParseError(format!(
                "incident {} missing title.ko or updates",
                inc.id
            )));
        }
    }
    Ok(snap)
}
