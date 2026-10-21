use crate::*;

/// L5-ORG production binding: unambiguous region/branch UUID → OrgUnit owner seam.
/// Free-text team labels never reach this helper (typed `Uuid` only).
pub(crate) async fn emit_region_or_branch_binding(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    command_id: Uuid,
    source_kind: &str,
    legacy_id: Uuid,
    name: &str,
) -> Result<(), PgOrgChangeError> {
    org_unit_binding::ensure_unambiguous_legacy_binding_in_tx(
        tx,
        org,
        actor,
        source_kind,
        legacy_id,
        serde_json::json!({ "name": name }),
        command_id,
    )
    .await
    .map_err(|err| {
        PgOrgChangeError::from(KernelError::conflict(format!(
            "org-unit binding for {source_kind}/{legacy_id} failed: {err}"
        )))
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Canonical OrgUnit ops (CREATE/RENAME/MOVE/DISSOLVE_ORG_UNIT)
//
// Reads here are SELECT-only against the OrgUnit owner's tables (the
// writer-ownership gate charges DML, not reads); every write goes through the
// injected [`OrgUnitWritePort`].
// ---------------------------------------------------------------------------

pub(crate) const fn is_org_unit_op(op: &OrgProposalOp) -> bool {
    matches!(
        op,
        OrgProposalOp::CreateOrgUnit { .. }
            | OrgProposalOp::RenameOrgUnit { .. }
            | OrgProposalOp::MoveOrgUnit { .. }
            | OrgProposalOp::DissolveOrgUnit { .. }
    )
}
