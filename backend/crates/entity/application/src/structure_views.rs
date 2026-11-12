//! Composed chart wire views.
use serde::Serialize;
use uuid::Uuid;

/// All → legal entity → workplace → department, departments nesting to any
/// depth (design §6.3, decisions #18).
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
    /// A workplace node's own unit (decisions #14.1): register people there
    /// with no department, or name it as a parent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_unit_id: Option<Uuid>,
    /// A workplace node's kind code (decisions #18; label only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workplace_kind: Option<String>,
    /// A workplace's or department's code (review R16; the department code is
    /// written by the setup batch's `SET_DETAILS` or an org change's `SET_ORG_UNIT_DETAILS`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// A department's dated head (D19): absent = vacant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<OrgUnitHeadRef>,
    /// Headcount: people who have not left, everything below included. On a
    /// legal entity it includes its unplaced (`direct_headcount`) (spec D1).
    pub headcount: i64,
    /// People on this node and on no child: on a department its own members,
    /// on a workplace "directly under the workplace" (its own unit), on a legal
    /// entity "unplaced" (a legal entity but no workplace).
    pub direct_headcount: i64,
    /// Of `headcount`, people employed as dispatch (DISPATCHED_IN) or on-site
    /// contractor (OUTSOURCED_ON_SITE): the "includes n dispatched / contractor"
    /// chip (review R13).
    pub dispatched_headcount: i64,
    /// Status chips: `needs_confirmation`, `suspended`, `closed`, `unverified`.
    pub chips: Vec<&'static str>,
    /// In order: sort order first, then name (department) or creation (workplace).
    pub children: Vec<OrgStructureNode>,
}

/// A department's head as of today (D19): a dated reference that may sit outside
/// the unit.
#[derive(Debug, Clone, Serialize)]
pub struct OrgUnitHeadRef {
    pub employee_id: Uuid,
    pub name: Option<String>,
    #[serde(with = "crate::iso_date::option")]
    pub since: Option<time::Date>,
    /// The "(concurrent)" mark: the head belongs to another unit, or heads
    /// another unit too.
    pub concurrent: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrgStructure {
    #[serde(flatten)]
    pub read: crate::ReadStamp,
    pub tenant_name: String,
    pub phase: String,
    pub entities: Vec<OrgStructureNode>,
    /// Units not yet placed under any workplace (legacy data; a to-do).
    pub unplaced: Vec<OrgStructureNode>,
    /// "Legal entity undecided": people who have not left and have no legal
    /// entity today. Only for a tenant-wide caller (`None` for a scoped one):
    /// they belong to no legal entity a scope could name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity_unknown_headcount: Option<i64>,
}
