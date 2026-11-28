// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

time::serde::format_description!(iso_date, Date, "[year]-[month]-[day]");

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RegulationImpact {
    pub id: uuid::Uuid,
    pub code: String,
    pub title: String,
    pub jurisdiction: String,
    pub regulator: Option<String>,
    pub citation: String,
    pub source_url: Option<String>,
    pub impact_area: String,
    pub impact_summary: String,
    pub risk_level: ComplianceRiskLevel,
    pub status: RegulationImpactStatus,
    #[serde(default, with = "iso_date::option")]
    pub effective_from: Option<time::Date>,
    #[serde(default, with = "iso_date::option")]
    pub effective_to: Option<time::Date>,
    #[serde(default, with = "iso_date::option")]
    pub review_due_on: Option<time::Date>,
    pub owner_user_id: Option<UserId>,
    pub metadata: serde_json::Value,
    pub created_by: UserId,
    pub updated_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ComplianceObligation {
    pub id: uuid::Uuid,
    pub code: String,
    pub title: String,
    pub description: String,
    pub obligation_type: ObligationType,
    pub scope: ComplianceScope,
    pub owner_user_id: Option<UserId>,
    pub severity: ComplianceRiskLevel,
    pub status: ObligationStatus,
    #[serde(default, with = "iso_date::option")]
    pub effective_from: Option<time::Date>,
    #[serde(default, with = "iso_date::option")]
    pub effective_to: Option<time::Date>,
    pub review_cadence: Option<ReviewCadence>,
    #[serde(default, with = "iso_date::option")]
    pub next_review_on: Option<time::Date>,
    pub metadata: serde_json::Value,
    pub created_by: UserId,
    pub updated_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ObligationRegulationLink {
    pub id: uuid::Uuid,
    pub obligation_id: uuid::Uuid,
    pub regulation_impact_id: uuid::Uuid,
    pub relationship: ObligationRegulationRelationship,
    pub rationale: Option<String>,
    pub created_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ComplianceFramework {
    pub id: uuid::Uuid,
    pub code: String,
    pub name: String,
    pub version_label: String,
    pub framework_kind: FrameworkKind,
    pub status: FrameworkStatus,
    pub owner_user_id: Option<UserId>,
    #[serde(default, with = "iso_date::option")]
    pub effective_from: Option<time::Date>,
    #[serde(default, with = "iso_date::option")]
    pub effective_to: Option<time::Date>,
    pub metadata: serde_json::Value,
    pub created_by: UserId,
    pub updated_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ComplianceControl {
    pub id: uuid::Uuid,
    pub framework_id: uuid::Uuid,
    pub control_key: String,
    pub title: String,
    pub objective: String,
    pub control_type: ControlType,
    pub cadence: Option<ControlCadence>,
    pub status: ControlStatus,
    pub evidence_requirements: serde_json::Value,
    pub owner_user_id: Option<UserId>,
    pub created_by: UserId,
    pub updated_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ControlObligationCoverage {
    pub id: uuid::Uuid,
    pub control_id: uuid::Uuid,
    pub obligation_id: uuid::Uuid,
    pub coverage_level: CoverageLevel,
    pub coverage_rationale: Option<String>,
    pub status: CoverageStatus,
    pub created_by: UserId,
    pub updated_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EvidenceBinding {
    pub id: uuid::Uuid,
    pub control_id: uuid::Uuid,
    pub obligation_id: Option<uuid::Uuid>,
    pub evidence_target_type: EvidenceTargetType,
    pub evidence_target_id: String,
    pub source_audit_event_id: Option<uuid::Uuid>,
    pub status: EvidenceBindingStatus,
    pub confidence: EvidenceConfidence,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub collected_at: Option<Timestamp>,
    pub collected_by: Option<UserId>,
    #[serde(default, with = "iso_date::option")]
    pub valid_from: Option<time::Date>,
    #[serde(default, with = "iso_date::option")]
    pub valid_to: Option<time::Date>,
    pub hash_sha256: Option<String>,
    pub metadata: serde_json::Value,
    pub created_by: UserId,
    pub updated_by: UserId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: Timestamp,
}
