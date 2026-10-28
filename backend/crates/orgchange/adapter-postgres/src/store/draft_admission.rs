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
        TargetKind::OrgUnit | TargetKind::Site | TargetKind::Entity => NodeRef {
            kind: if target.kind == TargetKind::Entity {
                NodeKind::LegalEntity
            } else {
                NodeKind::Department
            },
            id: Uuid::parse_str(&target.target_ref).map_err(|_| concealed())?,
        },
        // Legacy region/branch changes have no node in the canonical grant tree.
        TargetKind::Region | TargetKind::Branch => NodeRef {
            kind: NodeKind::Tenant,
            id: *org.as_uuid(),
        },
    };
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

pub(super) fn require_legacy(
    access: &DecisionFacts,
    org: OrgId,
    actor: UserId,
    proposal: &[OrgProposalOp],
) -> Result<(), PgOrgChangeError> {
    for op in proposal {
        let feature = match op {
            OrgProposalOp::CreateRegion { .. }
            | OrgProposalOp::RenameRegion { .. }
            | OrgProposalOp::DeactivateRegion { .. } => Feature::RegionManage,
            OrgProposalOp::CreateBranch { .. }
            | OrgProposalOp::RenameBranch { .. }
            | OrgProposalOp::DeactivateBranch { .. } => Feature::BranchManage,
            _ => return Err(KernelError::validation("expected a legacy org operation").into()),
        };
        if !org_change_draft::allowed(
            feature,
            &actor.to_string(),
            &org.to_string(),
            access.roles(),
            false,
        ) {
            return Err(
                KernelError::forbidden("legacy org draft permission required")
                    .with_code("org_change.refuse.missing_grant")
                    .into(),
            );
        }
    }
    Ok(())
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
