use crate::*;

// ---------------------------------------------------------------------------
// Proposal ops — the typed sandbox diff, replayed in order at apply time.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReassignScope {
    pub company: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum OrgProposalOp {
    #[serde(rename_all = "camelCase")]
    CreateRegion { name: String },
    #[serde(rename_all = "camelCase")]
    RenameRegion { region_id: Uuid, name: String },
    #[serde(rename_all = "camelCase")]
    DeactivateRegion { region_id: Uuid },
    #[serde(rename_all = "camelCase")]
    CreateBranch { region_id: Uuid, name: String },
    /// Rename and/or move a branch across regions.
    #[serde(rename_all = "camelCase")]
    RenameBranch {
        branch_id: Uuid,
        name: Option<String>,
        region_id: Option<Uuid>,
    },
    #[serde(rename_all = "camelCase")]
    DeactivateBranch { branch_id: Uuid },
    /// Slice 1 covers the org-tree edit semantics (사업장 추가 / rename);
    /// extended site fields keep routing through the registry REST surface.
    #[serde(rename_all = "camelCase")]
    CreateSite { customer_id: Uuid, name: String },
    #[serde(rename_all = "camelCase")]
    UpdateSite { site_id: Uuid, name: String },
    /// Members move: a dated 전보 (and 전근 when the target sits at another
    /// 사업장) per person, batched under the change. `from_org_unit` /
    /// `to_org_unit` are OrgUnit UUID strings (not free-text team labels).
    /// `employee_ids`, when given, moves only those members of the source
    /// (org-06: per-person destinations are one op per destination).
    #[serde(rename_all = "camelCase")]
    ReassignOrgUnit {
        from_org_unit: String,
        to_org_unit: String,
        scope: ReassignScope,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        employee_ids: Option<Vec<Uuid>>,
    },
    /// Canonical OrgUnit create. `parent_id` must name an existing ACTIVE unit
    /// (the Company root id, or null, for a SITE). Applied through the OrgUnit
    /// owner's `organization.create_org_unit` write.
    #[serde(rename_all = "camelCase")]
    CreateOrgUnit {
        kind: OrgUnitKind,
        parent_id: Option<Uuid>,
        name: String,
    },
    /// `organization.revise_org_unit` with a new name.
    #[serde(rename_all = "camelCase")]
    RenameOrgUnit { org_unit_id: Uuid, name: String },
    /// `organization.revise_org_unit` with a new parent (kind nesting and
    /// cycle rules re-checked at preflight and at apply).
    #[serde(rename_all = "camelCase")]
    MoveOrgUnit { org_unit_id: Uuid, parent_id: Uuid },
    /// `organization.revise_org_unit` with `status = dissolved`. Blocked while
    /// the unit has active members or active children. `merged_into` names
    /// the unit it was merged into (합치기, org-07): kept on the dissolved
    /// revision as its successor, so history and grants can follow it.
    #[serde(rename_all = "camelCase")]
    DissolveOrgUnit {
        org_unit_id: Uuid,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        merged_into: Option<Uuid>,
    },
}

/// The OrgUnit kinds the canonical domain admits (revision `kind` attribute,
/// stored lowercase). The Company is not an OrgUnit kind: it is the tenant
/// (`organizations`), projected as the tree root by the read API only.
///
/// One 부서 kind (decisions #18): a 부서 sits in a 사업장 (SITE) or in another
/// 부서, to any depth. The retired `TEAM` is read as `DEPARTMENT` (stored
/// proposals and older clients still send it; 0262 relabelled the units).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum OrgUnitKind {
    Site,
    #[serde(alias = "TEAM")]
    Department,
}

impl OrgUnitKind {
    /// The stored revision-attribute spelling.
    #[must_use]
    pub const fn as_attr(self) -> &'static str {
        match self {
            Self::Site => "site",
            Self::Department => "department",
        }
    }

    #[must_use]
    pub fn from_attr(value: &str) -> Option<Self> {
        match value {
            "site" => Some(Self::Site),
            "department" | "team" => Some(Self::Department),
            _ => None,
        }
    }

    /// Nesting rule the OrgUnit port enforces: SITE is a root under the
    /// Company; a DEPARTMENT sits under a SITE or a DEPARTMENT.
    #[must_use]
    pub const fn admits_parent(self, parent: Option<Self>) -> bool {
        matches!(
            (self, parent),
            (Self::Site, None) | (Self::Department, Some(Self::Site | Self::Department))
        )
    }
}

pub(crate) const MAX_PROPOSAL_OPS: usize = 100;

pub(crate) fn bounded(value: &str, name: &str, max: usize) -> Result<(), KernelError> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(KernelError::validation(format!(
            "{name} is required and must be at most {max} characters"
        )));
    }
    Ok(())
}

/// A bare SITE unit is never created: a 사업장 is created through its 법인
/// (`POST /api/v1/legal-entities/{id}/workplaces`), which makes its own unit
/// (decisions #14.1, #18).
pub const SITE_NEEDS_WORKPLACE: &str = "site_needs_workplace";
/// 지역 and 지점 are retired as separate concepts (decisions #18): a 지점 is a
/// 사업장 of kind 지점, created and renamed through its 법인.
pub const REGION_BRANCH_RETIRED: &str = "region_branch_retired";
/// A branch that backs a 사업장 closes with its 사업장, never on its own.
pub const BRANCH_BACKS_WORKPLACE: &str = "branch_backs_workplace";
/// A 사업장's own SITE unit is renamed and closed with its 사업장 (the entity
/// face's code for the same refusal).
pub const SITE_IS_A_WORKPLACE: &str = "site_is_a_workplace";
/// The codes above, which the REST face answers as `error.code`.
pub const ORG_STRUCTURE_CODES: [&str; 4] = [
    SITE_NEEDS_WORKPLACE,
    REGION_BRANCH_RETIRED,
    BRANCH_BACKS_WORKPLACE,
    SITE_IS_A_WORKPLACE,
];

/// A scheduled change keeps its content (예약 수정 moves its date or reason).
pub const ORG_CHANGE_SCHEDULED_CONTENT: &str = "org_change_scheduled_content";
/// Under routing, an approved change is moved or cancelled only by an applier.
pub const ORG_CHANGE_SCHEDULED_LOCKED: &str = "org_change_scheduled_locked";
/// The codes an org change answers with when it cannot move its people
/// (org-01, org-04): the person-move refusals keep their own code, so the
/// console names the reason (a 법인 crossed, a later scheduled event …).
pub const ORG_CHANGE_CODES: [&str; 14] = [
    "org_change_sod_violation",
    "org_change.refuse.missing_grant",
    "org_change.refuse.identity_unbound",
    ORG_CHANGE_SCHEDULED_CONTENT,
    ORG_CHANGE_SCHEDULED_LOCKED,
    "transfer_cross_entity",
    "entity_change_needs_group_transfer",
    "org_unit_at_other_workplace",
    "workplace_not_open",
    "employee_unassigned",
    "lifecycle_schedule_conflict",
    "assignment_after_move",
    "assignment_starts_on_move_date",
    "org_unit_not_assignable",
];

/// The first retired op of `ops` (decisions #18), as its refusal.
///
/// # Errors
/// [`OrgProposalOp::retired`] of the first retired op.
pub fn refuse_retired(ops: &[OrgProposalOp]) -> Result<(), KernelError> {
    ops.iter()
        .find_map(OrgProposalOp::retired)
        .map_or(Ok(()), Err)
}

impl OrgProposalOp {
    /// Why this op may no longer be proposed or applied (decisions #18), if
    /// it is retired. Checked when a draft is written and again at preflight
    /// and apply, so a draft stored before the retirement cannot apply.
    #[must_use]
    pub fn retired(&self) -> Option<KernelError> {
        match self {
            Self::CreateOrgUnit {
                kind: OrgUnitKind::Site,
                ..
            } => Some(
                KernelError::validation(
                    "a workplace is created through its legal entity, never as a bare SITE unit",
                )
                .with_code(SITE_NEEDS_WORKPLACE),
            ),
            Self::CreateRegion { .. }
            | Self::RenameRegion { .. }
            | Self::CreateBranch { .. }
            | Self::RenameBranch { .. } => Some(
                KernelError::validation(
                    "regions and branches are retired: a branch is a workplace of its legal entity",
                )
                .with_code(REGION_BRANCH_RETIRED),
            ),
            _ => None,
        }
    }

    pub fn validate(&self) -> Result<(), KernelError> {
        if let Some(retired) = self.retired() {
            return Err(retired);
        }
        match self {
            Self::CreateRegion { name }
            | Self::RenameRegion { name, .. }
            | Self::CreateBranch { name, .. }
            | Self::CreateSite { name, .. }
            | Self::UpdateSite { name, .. }
            | Self::CreateOrgUnit { name, .. }
            | Self::RenameOrgUnit { name, .. } => bounded(name, "name", 120),
            Self::MoveOrgUnit {
                org_unit_id,
                parent_id,
            } => {
                if org_unit_id == parent_id {
                    return Err(KernelError::validation(
                        "MOVE_ORG_UNIT parentId must differ from orgUnitId",
                    ));
                }
                Ok(())
            }
            Self::DissolveOrgUnit {
                org_unit_id,
                merged_into,
            } => {
                if merged_into.as_ref() == Some(org_unit_id) {
                    return Err(KernelError::validation(
                        "DISSOLVE_ORG_UNIT mergedInto must differ from orgUnitId",
                    ));
                }
                Ok(())
            }
            Self::RenameBranch {
                name, region_id, ..
            } => {
                if name.is_none() && region_id.is_none() {
                    return Err(KernelError::validation(
                        "RENAME_BRANCH requires a name and/or a target region",
                    ));
                }
                name.as_deref()
                    .map(|n| bounded(n, "name", 120))
                    .transpose()?;
                Ok(())
            }
            Self::DeactivateRegion { .. } | Self::DeactivateBranch { .. } => Ok(()),
            Self::ReassignOrgUnit {
                from_org_unit,
                to_org_unit,
                scope,
                employee_ids,
            } => {
                if employee_ids
                    .as_ref()
                    .is_some_and(|ids| ids.is_empty() || ids.len() > 5000)
                {
                    return Err(KernelError::validation(
                        "REASSIGN_ORG_UNIT employeeIds, when given, names 1 to 5000 people",
                    ));
                }
                bounded(from_org_unit, "fromOrgUnit", 120)?;
                bounded(to_org_unit, "toOrgUnit", 120)?;
                bounded(&scope.company, "scope.company", 120)?;
                if Uuid::parse_str(from_org_unit.trim()).is_err()
                    || Uuid::parse_str(to_org_unit.trim()).is_err()
                {
                    return Err(KernelError::validation(
                        "REASSIGN_ORG_UNIT fromOrgUnit/toOrgUnit must be OrgUnit UUIDs",
                    ));
                }
                if from_org_unit == to_org_unit {
                    return Err(KernelError::validation(
                        "REASSIGN_ORG_UNIT source and target must differ",
                    ));
                }
                Ok(())
            }
        }
    }
}

pub fn validate_proposal(ops: &[OrgProposalOp]) -> Result<(), KernelError> {
    if ops.len() > MAX_PROPOSAL_OPS {
        return Err(KernelError::validation(format!(
            "proposal may contain at most {MAX_PROPOSAL_OPS} ops"
        )));
    }
    for op in ops {
        op.validate()?;
    }
    Ok(())
}
