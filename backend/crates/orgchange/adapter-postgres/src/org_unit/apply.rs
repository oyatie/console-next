use crate::*;

/// Apply one org-unit op through the owner's port, re-verifying the preflight
/// guards inside the apply transaction (state can move after approval).
#[allow(clippy::too_many_arguments)] // mirrors apply_op plus the effective date and the port
pub(crate) async fn apply_org_unit_op(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    command_id: Uuid,
    op: &OrgProposalOp,
    effective_date: Date,
    now: OffsetDateTime,
    port: &dyn OrgUnitWritePort,
) -> Result<AuditEvent, PgOrgChangeError> {
    let effective_from = format!(
        "{:04}-{:02}-{:02}",
        effective_date.year(),
        u8::from(effective_date.month()),
        effective_date.day()
    );
    let active_head = |head: Option<UnitHead>| {
        head.filter(|head| !head.dissolved)
            .ok_or_else(|| PgOrgChangeError::from(KernelError::conflict("org unit is not active")))
    };
    if let OrgProposalOp::RenameOrgUnit { org_unit_id, .. }
    | OrgProposalOp::DissolveOrgUnit { org_unit_id, .. } = op
        && represents_workplace(tx, *org_unit_id).await?
    {
        return Err(KernelError::conflict(
            "a workplace's own unit is renamed and closed with its workplace",
        )
        .with_code(SITE_IS_A_WORKPLACE)
        .into());
    }
    let (id, before, after) = match op {
        OrgProposalOp::CreateOrgUnit {
            kind,
            parent_id,
            name,
        } => {
            let parent = resolve_parent(tx, org, *parent_id).await?.map_err(|()| {
                PgOrgChangeError::from(KernelError::conflict("parent org unit is not active"))
            })?;
            let mut attributes = serde_json::json!({
                "name": name,
                "kind": kind.as_attr(),
                "status": "active",
                "effective_from": effective_from,
            });
            if let Some(parent) = parent {
                attributes["parent_id"] = Value::String(parent.id.to_string());
            }
            let id = port
                .write(tx, org, actor, command_id, None, attributes.clone())
                .await
                .map_err(port_refusal)?;
            (id, None, attributes)
        }
        OrgProposalOp::RenameOrgUnit { org_unit_id, name } => {
            let head = active_head(load_unit_head(tx, *org_unit_id).await?)?;
            let mut attributes = head.attributes.clone();
            attributes["name"] = Value::String(name.clone());
            attributes["effective_from"] = Value::String(effective_from);
            port.write(
                tx,
                org,
                actor,
                command_id,
                Some(head.id),
                attributes.clone(),
            )
            .await
            .map_err(port_refusal)?;
            (head.id, Some(head.attributes), attributes)
        }
        OrgProposalOp::MoveOrgUnit {
            org_unit_id,
            parent_id,
        } => {
            let head = active_head(load_unit_head(tx, *org_unit_id).await?)?;
            let parent = resolve_parent(tx, org, Some(*parent_id))
                .await?
                .map_err(|()| {
                    PgOrgChangeError::from(KernelError::conflict("parent org unit is not active"))
                })?;
            if !head.kind.admits_parent(parent.as_ref().map(|p| p.kind)) {
                return Err(
                    KernelError::conflict("org unit kind cannot nest under that parent").into(),
                );
            }
            let mut attributes = head.attributes.clone();
            match parent {
                Some(parent) => attributes["parent_id"] = Value::String(parent.id.to_string()),
                None => {
                    if let Some(object) = attributes.as_object_mut() {
                        object.remove("parent_id");
                    }
                }
            }
            attributes["effective_from"] = Value::String(effective_from);
            // Cycles are refused by the port itself (ancestor walk, no mutation).
            port.write(
                tx,
                org,
                actor,
                command_id,
                Some(head.id),
                attributes.clone(),
            )
            .await
            .map_err(port_refusal)?;
            (head.id, Some(head.attributes), attributes)
        }
        OrgProposalOp::DissolveOrgUnit {
            org_unit_id,
            merged_into,
        } => {
            let head = active_head(load_unit_head(tx, *org_unit_id).await?)?;
            // 합치기 (org-07): the successor must still be active, and is kept.
            if let Some(successor) = merged_into {
                active_head(load_unit_head(tx, *successor).await?)?;
            }
            if unit_members(tx, head.id).await? > 0 {
                return Err(KernelError::conflict(
                    "employees (on leave included) remain in the org unit",
                )
                .into());
            }
            if active_unit_children(tx, head.id).await? > 0 {
                return Err(KernelError::conflict("active child org units remain").into());
            }
            let mut attributes = head.attributes.clone();
            attributes["status"] = Value::String("dissolved".to_owned());
            if let Some(successor) = merged_into {
                attributes["merged_into"] = Value::String(successor.to_string());
            }
            attributes["effective_from"] = Value::String(effective_from);
            port.write(
                tx,
                org,
                actor,
                command_id,
                Some(head.id),
                attributes.clone(),
            )
            .await
            .map_err(port_refusal)?;
            (head.id, Some(head.attributes), attributes)
        }
        _ => return Err(KernelError::internal("not an org-unit op").into()),
    };
    Ok(audit(
        org,
        actor,
        "org_change.apply.op",
        "org_unit",
        id.to_string(),
        now,
    )?
    .with_snapshots(before, Some(after)))
}
