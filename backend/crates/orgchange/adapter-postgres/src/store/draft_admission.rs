// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_platform_authz::{
    Feature,
    access::{NodeKind, NodeRef},
    cedar_pbac::{
        actions::org_change_draft,
        visible::{DecisionFacts, load_facts},
    },
};

pub(super) fn concealed() -> KernelError {
    KernelError::not_found("org-change request was not found")
        .with_code("org_change.refuse.missing_grant")
}

pub(super) fn allows(
    access: &DecisionFacts,
    org: OrgId,
    actor: UserId,
    feature: Feature,
    target: &OrgChangeTarget,
) -> Result<bool, PgOrgChangeError> {
    let resource = match target.kind {
        TargetKind::OrgUnit | TargetKind::Site | TargetKind::Entity => {
            let id = Uuid::parse_str(&target.target_ref).map_err(|_| concealed())?;
            NodeRef {
                kind: if target.kind == TargetKind::Entity {
                    NodeKind::LegalEntity
                } else if target.kind == TargetKind::OrgUnit && id == *org.as_uuid() {
                    NodeKind::Tenant
                } else {
                    NodeKind::Department
                },
                id,
            }
        }
        // Legacy region/branch changes have no node in the canonical grant tree.
        TargetKind::Region | TargetKind::Branch => NodeRef {
            kind: NodeKind::Tenant,
            id: *org.as_uuid(),
        },
    };
    allows_resource(access, org, actor, feature, resource)
}

fn allows_resource(
    access: &DecisionFacts,
    org: OrgId,
    actor: UserId,
    feature: Feature,
    resource: NodeRef,
) -> Result<bool, PgOrgChangeError> {
    let holds = access
        .authorize(feature.as_str(), resource)
        .map_err(|_| concealed())?;
    Ok(org_change_draft::allowed(
        feature,
        &actor.to_string(),
        &org.to_string(),
        access.roles(),
        holds,
    ))
}

pub(super) fn proposal_allows(
    access: &DecisionFacts,
    org: OrgId,
    actor: UserId,
    feature: Feature,
    proposal: &[OrgProposalOp],
) -> Result<bool, PgOrgChangeError> {
    for op in proposal {
        for resource in proposal_resources(org, op)?.into_iter().flatten() {
            if !allows_resource(access, org, actor, feature, resource)? {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn proposal_resources(
    org: OrgId,
    op: &OrgProposalOp,
) -> Result<[Option<NodeRef>; 2], PgOrgChangeError> {
    let tenant = || NodeRef {
        kind: NodeKind::Tenant,
        id: *org.as_uuid(),
    };
    let unit = |id| NodeRef {
        kind: if id == *org.as_uuid() {
            NodeKind::Tenant
        } else {
            NodeKind::Department
        },
        id,
    };
    let resources = match op {
        OrgProposalOp::CreateRegion { .. }
        | OrgProposalOp::RenameRegion { .. }
        | OrgProposalOp::DeactivateRegion { .. }
        | OrgProposalOp::CreateBranch { .. }
        | OrgProposalOp::RenameBranch { .. }
        | OrgProposalOp::DeactivateBranch { .. }
        | OrgProposalOp::CreateSite { .. }
        | OrgProposalOp::UpdateSite { .. } => [Some(tenant()), None],
        OrgProposalOp::ReassignOrgUnit {
            from_org_unit,
            to_org_unit,
            ..
        } => [
            Some(unit(
                Uuid::parse_str(from_org_unit.trim()).map_err(|_| concealed())?,
            )),
            Some(unit(
                Uuid::parse_str(to_org_unit.trim()).map_err(|_| concealed())?,
            )),
        ],
        OrgProposalOp::CreateOrgUnit { parent_id, .. } => {
            [Some(parent_id.map_or_else(tenant, unit)), None]
        }
        OrgProposalOp::RenameOrgUnit { org_unit_id, .. } => [Some(unit(*org_unit_id)), None],
        OrgProposalOp::MoveOrgUnit {
            org_unit_id,
            parent_id,
        } => [Some(unit(*org_unit_id)), Some(unit(*parent_id))],
        OrgProposalOp::DissolveOrgUnit {
            org_unit_id,
            merged_into,
        } => [Some(unit(*org_unit_id)), merged_into.map(unit)],
    };
    Ok(resources)
}

pub(super) fn require_proposal(
    access: &DecisionFacts,
    org: OrgId,
    actor: UserId,
    proposal: &[OrgProposalOp],
) -> Result<(), PgOrgChangeError> {
    if proposal_allows(access, org, actor, Feature::OrgChangeDraft, proposal)? {
        Ok(())
    } else {
        Err(concealed().into())
    }
}

pub(super) fn require(
    access: &DecisionFacts,
    org: OrgId,
    actor: UserId,
    target: &OrgChangeTarget,
) -> Result<(), PgOrgChangeError> {
    if allows(access, org, actor, Feature::OrgChangeDraft, target)? {
        Ok(())
    } else {
        Err(concealed().into())
    }
}

pub(super) async fn lock(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
) -> Result<(RequestRow, DecisionFacts), PgOrgChangeError> {
    let access = load_facts(tx, org, *actor.as_uuid()).await?;
    let request = lock_request(tx, id).await.map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            concealed().into()
        } else {
            error
        }
    })?;
    Ok((request, access))
}
