//! Composed chart wire views.
use serde::Serialize;
use uuid::Uuid;

/// 전체 → 법인 → 사업장 → 부서, 부서 nesting to any depth (design §6.3,
/// decisions #18).
#[derive(Debug, Clone, Serialize)]
pub struct OrgStructureNode {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_by: Option<crate::ScheduledBy>,
    pub changed_after: bool,
    pub kind: &'static str,
    pub id: Uuid,
    pub name: String,
    /// A unit node's current version: the `expected_version` of a setup op.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    /// A 사업장 node's own unit (decisions #14.1): register people there
    /// with no 부서, or name it as a parent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit_id: Option<Uuid>,
    /// A 사업장 node's kind code (decisions #18; label only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workplace_kind: Option<String>,
    /// A 사업장's or 부서's code (review R16; 부서 코드 is written by the
    /// setup batch's `SET_DETAILS` or an org change's `SET_ORG_UNIT_DETAILS`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// A 부서's dated head (D19): absent = 공석.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<OrgUnitHeadRef>,
    /// 인원: people who have not left, everything below included. On a 법인
    /// it includes its 미배치 (`direct_headcount`) (spec D1).
    pub headcount: i64,
    /// People on this node and on no child: on a 부서 its own members, on a
    /// 사업장 「사업장 직속」 (its own unit), on a 법인 「미배치」 (a 법인
    /// but no 사업장).
    pub direct_headcount: i64,
    /// Of `headcount`, people employed as 파견 (DISPATCHED_IN) or 사내 협력
    /// (OUTSOURCED_ON_SITE): the 「파견·협력 n명 포함」 chip (review R13).
    pub dispatched_headcount: i64,
    /// Status chips: `needs_confirmation`, `suspended`, `closed`, `unverified`.
    pub chips: Vec<&'static str>,
    /// In order: 순서 first, then name (부서) or creation (사업장).
    pub children: Vec<OrgStructureNode>,
}

/// A 부서's head as of today (D19): a dated reference that may sit outside
/// the unit.
#[derive(Debug, Clone, Serialize)]
pub struct OrgUnitHeadRef {
    pub employee_id: Uuid,
    pub name: Option<String>,
    #[serde(with = "crate::iso_date::option")]
    pub since: Option<time::Date>,
    /// 「(겸)」: the head belongs to another unit, or heads another unit too.
    pub concurrent: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrgStructure {
    #[serde(flatten)]
    pub read: crate::ReadStamp,
    pub tenant_name: String,
    pub phase: String,
    pub entities: Vec<OrgStructureNode>,
    /// Units not yet placed under any 사업장 (legacy data; a to-do).
    pub unplaced: Vec<OrgStructureNode>,
    /// 「법인 미정」: people who have not left and have no 법인 today. Only
    /// for a tenant-wide caller (`None` for a scoped one): they belong to no
    /// 법인 a scope could name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_unknown_headcount: Option<i64>,
}
