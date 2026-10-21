//! The setup 부서 ops (create, rename, move, dissolve, details), applied inside
//! a [`Run`]. There is one 부서 kind (decisions #18): the level follows from
//! where the unit goes, never from a type the client picks.

use console_entity_application::{OrgParent, OrgSetupOp};
use console_entity_domain::{Issues, Refusal};
use serde_json::json;
use uuid::Uuid;

use crate::org_batch::Run;
use crate::org_details;
use crate::org_tree::{self, Head};
use crate::{PgEntityError, Tx};

const NAME_MAX: usize = 120;

/// The existing units an op names, locked before the batch runs.
pub(crate) fn named_units(op: &OrgSetupOp) -> Vec<Uuid> {
    let parent = |p: &OrgParent| p.parent_org_unit_id;
    match op {
        OrgSetupOp::Create { parent: p, .. } => parent(p).into_iter().collect(),
        OrgSetupOp::Move {
            org_unit_id,
            parent: p,
            ..
        } => org_unit_id.iter().copied().chain(parent(p)).collect(),
        OrgSetupOp::Rename { org_unit_id, .. }
        | OrgSetupOp::Dissolve { org_unit_id, .. }
        | OrgSetupOp::SetDetails { org_unit_id, .. } => org_unit_id.iter().copied().collect(),
    }
}

pub(crate) async fn apply(
    tx: &mut Tx<'_>,
    run: &mut Run<'_>,
    i: usize,
    op: &OrgSetupOp,
) -> Result<(), PgEntityError> {
    match op {
        OrgSetupOp::Create {
            client_ref,
            name,
            parent,
            code,
            head_employee_id,
        } => {
            let name = text(run, i, name.as_deref())?;
            if client_ref
                .as_ref()
                .is_some_and(|r| r.trim().is_empty() || run.refs.contains_key(r))
            {
                return Err(run.refuse(i, "ref", "duplicate_ref"));
            }
            let parent = resolve_parent(tx, run, i, parent).await?;
            free_name(tx, run, i, parent, &name, None).await?;
            let mut attributes = json!({ "name": name, "kind": "department", "status": "active", "parent_id": parent.to_string() });
            org_details::set(
                tx,
                run,
                i,
                None,
                &mut attributes,
                code.as_deref(),
                *head_employee_id,
            )
            .await?;
            let id = run
                .write(
                    tx,
                    i,
                    client_ref.clone(),
                    None,
                    attributes,
                    "org_unit.setup_create",
                )
                .await?;
            // org-13: a create named by a ref is part of an outline (a paste, an import) and keeps its typed place;
            // a single add stays in name order until an order is given.
            if client_ref.is_some() {
                crate::org_position::append(tx, parent, id, *run.actor.user.as_uuid()).await?;
            }
            if let Some(r) = client_ref {
                run.refs.insert(r.clone(), id);
            }
        }
        OrgSetupOp::Rename {
            org_unit_id,
            expected_version,
            name,
        } => {
            let name = text(run, i, name.as_deref())?;
            let (id, head) = target(tx, run, i, *org_unit_id, "revise_workplace").await?;
            run.pinned(i, id, &head, *expected_version)?;
            if head.name() != name {
                if let Some(parent) = head.parent() {
                    free_name(tx, run, i, parent, &name, Some(id)).await?;
                }
                let mut attributes = head.attributes.clone();
                attributes["name"] = json!(name);
                run.write(
                    tx,
                    i,
                    None,
                    Some((id, head)),
                    attributes,
                    "org_unit.setup_rename",
                )
                .await?;
            }
        }
        OrgSetupOp::Move {
            org_unit_id,
            expected_version,
            parent,
        } => {
            let (id, head) = target(tx, run, i, *org_unit_id, "void_workplace").await?;
            run.pinned(i, id, &head, *expected_version)?;
            let parent = resolve_parent(tx, run, i, parent).await?;
            if head.parent() != Some(parent) {
                if org_tree::is_ancestor(tx, id, parent).await? {
                    return Err(run.refuse(i, "parent_org_unit_id", "move_into_own_subtree"));
                }
                free_name(tx, run, i, parent, head.name(), Some(id)).await?;
                let mut attributes = head.attributes.clone();
                attributes["parent_id"] = json!(parent.to_string());
                run.write(
                    tx,
                    i,
                    None,
                    Some((id, head)),
                    attributes,
                    "org_unit.setup_move",
                )
                .await?;
                // A moved 부서 goes last among its new siblings, never at the
                // place its old position number happens to land.
                crate::org_position::append(tx, parent, id, *run.actor.user.as_uuid()).await?;
            }
        }
        OrgSetupOp::Dissolve {
            org_unit_id,
            expected_version,
        } => {
            let (id, head) = target(tx, run, i, *org_unit_id, "void_workplace").await?;
            run.pinned(i, id, &head, *expected_version)?;
            let units = org_tree::subtree(tx, &[id]).await?;
            org_tree::lock_units(tx, &units).await?;
            let people = org_tree::members(tx, &units).await?;
            if people > 0 {
                return Err(Refusal::conflict(
                    "org_unit_has_members",
                    format!(
                        "{people} people who have not left are placed in org unit {id} or under it"
                    ),
                )
                .with_remedy("move_people_first")
                .into());
            }
            for unit in units {
                let head = org_tree::head(tx, unit)
                    .await?
                    .ok_or_else(|| Refusal::not_found("org_unit_not_found"))?;
                let mut attributes = head.attributes.clone();
                attributes["status"] = json!("dissolved");
                run.write(
                    tx,
                    i,
                    None,
                    Some((unit, head)),
                    attributes,
                    "org_unit.setup_dissolve",
                )
                .await?;
            }
        }
        OrgSetupOp::SetDetails {
            org_unit_id,
            expected_version,
            code,
            head_employee_id,
        } => {
            let (id, head) = target(tx, run, i, *org_unit_id, "revise_workplace").await?;
            run.pinned(i, id, &head, *expected_version)?;
            let mut attributes = head.attributes.clone();
            org_details::set(
                tx,
                run,
                i,
                Some(id),
                &mut attributes,
                code.as_deref(),
                *head_employee_id,
            )
            .await?;
            if attributes != head.attributes {
                run.write(
                    tx,
                    i,
                    None,
                    Some((id, head)),
                    attributes,
                    "org_unit.setup_details",
                )
                .await?;
            }
        }
    }
    Ok(())
}

fn text(run: &Run<'_>, i: usize, raw: Option<&str>) -> Result<String, PgEntityError> {
    let mut is = Issues::default();
    let name = is.text(&run.field(i, "name"), raw, NAME_MAX, true);
    Ok(is.finish_opt(|| name)?)
}

/// An existing, active 부서. A 사업장's own unit is changed through the 사업장.
async fn target(
    tx: &mut Tx<'_>,
    run: &Run<'_>,
    i: usize,
    id: Option<Uuid>,
    site_remedy: &'static str,
) -> Result<(Uuid, Head), PgEntityError> {
    let id = id.ok_or_else(|| run.refuse(i, "org_unit_id", "required"))?;
    let head = org_tree::head(tx, id)
        .await?
        .filter(Head::active)
        .ok_or_else(|| Refusal::not_found("org_unit_not_found"))?;
    if head.kind() == "site" {
        return Err(
            Refusal::conflict("site_is_a_workplace", "change the 사업장 instead")
                .with_remedy(site_remedy)
                .into(),
        );
    }
    Ok((id, head))
}

/// The unit a created or moved 부서 goes under: a 사업장's own unit, an
/// active 부서, or a unit created earlier in the batch, in an open 사업장.
async fn resolve_parent(
    tx: &mut Tx<'_>,
    run: &mut Run<'_>,
    i: usize,
    p: &OrgParent,
) -> Result<Uuid, PgEntityError> {
    let parent = match (
        p.workplace_id,
        p.parent_org_unit_id,
        p.parent_ref.as_deref(),
    ) {
        (Some(workplace), None, None) => {
            if !org_tree::workplace_open(tx, workplace).await? {
                return Err(run.refuse(i, "workplace_id", "workplace_not_found"));
            }
            let (actor, port) = (run.actor, run.port);
            return crate::site_unit::workplace_unit(
                tx,
                actor,
                workplace,
                run.today,
                run.admitted,
                port,
            )
            .await;
        }
        (None, Some(unit), None) => unit,
        (None, None, Some(r)) => {
            return run
                .refs
                .get(r)
                .copied()
                .ok_or_else(|| run.refuse(i, "parent_ref", "unknown_ref"));
        }
        _ => return Err(run.refuse(i, "parent_org_unit_id", "one_parent_required")),
    };
    let head = org_tree::head(tx, parent).await?.filter(Head::active);
    if !head.is_some_and(|h| matches!(h.kind(), "site" | "department" | "team")) {
        return Err(run.refuse(i, "parent_org_unit_id", "org_unit_not_found"));
    }
    if let Some(workplace) = org_tree::workplace_of(tx, parent).await?
        && !org_tree::workplace_open(tx, workplace).await?
    {
        return Err(run.refuse(i, "parent_org_unit_id", "workplace_closed"));
    }
    Ok(parent)
}

/// Two active 부서 under one parent never share a name (the import's
/// exact-name linking would be ambiguous).
async fn free_name(
    tx: &mut Tx<'_>,
    run: &Run<'_>,
    i: usize,
    parent: Uuid,
    name: &str,
    except: Option<Uuid>,
) -> Result<(), PgEntityError> {
    if org_tree::sibling_taken(tx, parent, name, except).await? {
        return Err(run.refuse(i, "name", "name_taken_in_parent"));
    }
    Ok(())
}
