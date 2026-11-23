// SPDX-License-Identifier: LicenseRef-Proprietary
use serde::{Deserialize, Serialize};

use crate::UtcTimestamp;
use crate::ladders::{Incident, IncidentSeverity, PublicComponent};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PersonalDataImpact {
    Yes,
    No,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PublicDraftStage {
    Status(Incident),
    Component(PublicComponent),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicUpdateDraft {
    pub stage: PublicDraftStage,
    pub components: Vec<String>,
    pub message_ko: String,
    pub message_en: String,
    pub rev: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncidentTimelineEntry {
    pub seq: u64,
    pub at: UtcTimestamp,
    pub actor: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LegalClock {
    pub kind: &'static str,
    pub deadline: UtcTimestamp,
    pub remaining_s: i64,
    pub overdue: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "event",
    content = "fields",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum IncidentEvent {
    Declared {
        title: String,
        sev: IncidentSeverity,
        #[serde(default)]
        lead: Option<String>,
        #[serde(default)]
        affected_components: Vec<String>,
        personal_data_impact: PersonalDataImpact,
        #[serde(default)]
        intrusion: bool,
        discovered_at: UtcTimestamp,
        #[serde(default)]
        next_public_update_at: Option<UtcTimestamp>,
        #[serde(default)]
        public_incident_id: Option<String>,
    },
    LeadAssigned {
        lead: String,
    },
    NoteAdded {
        note: String,
    },
    SeverityChanged {
        sev: IncidentSeverity,
        #[serde(default)]
        reason: Option<String>,
    },
    StatusChanged {
        status: Incident,
        #[serde(default)]
        next_public_update_at: Option<UtcTimestamp>,
        #[serde(default)]
        reason: Option<String>,
    },
    PostmortemLinked {
        postmortem_ref: String,
    },
    PublicAttached {
        public_incident_id: String,
    },
    MitigationAdded {
        action_id: String,
        summary: String,
    },
    PublicDrafted {
        draft: PublicUpdateDraft,
        action_id: String,
    },
    NoticeSent {
        channel: String,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        next_public_update_at: Option<UtcTimestamp>,
    },
    Resolved {
        #[serde(default)]
        summary: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncidentRefusal {
    Invalid,
    NotFound,
    Conflict,
    PostmortemRequired,
    Final,
}

impl IncidentRefusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "OPS_INCIDENT_INVALID",
            Self::NotFound => "OPS_INCIDENT_NOT_FOUND",
            Self::Conflict => "OPS_INCIDENT_CONFLICT",
            Self::PostmortemRequired => "OPS_POSTMORTEM_REQUIRED",
            Self::Final => "OPS_INCIDENT_FINAL",
        }
    }
}
