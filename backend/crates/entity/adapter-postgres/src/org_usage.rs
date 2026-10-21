//! What a 부서 and its active sub-부서 were used for (CRUD): the facts that
//! decide whether it is erased (never used) or 폐지 (used), and the typed
//! refusal for the way not offered. Read inside the write's transaction, so
//! the decision and the write see the same rows.

use console_entity_application::{Actor, OrgSetupOp};
use console_entity_domain::Refusal;
use console_kernel_core::{ChangeMode, TenantPhase};
use uuid::Uuid;

use crate::org_tree::{self, Head};
use crate::org_units::OrgUnitSetupWritePort;
use crate::{Admitted, PgEntityError, Tx, read_phase};

/// What a unit and its active sub-부서 were used for.
pub(crate) struct Usage {
    pub units: Vec<Uuid>,
    pub members: i64,
    pub people_ever: i64,
    pub history: i64,
    /// The open org change that names the unit (its id and code), if any.
    pub held_by: Option<(Uuid, String)>,
}

pub(crate) async fn usage(tx: &mut Tx<'_>, root: Uuid) -> Result<Usage, PgEntityError> {
    let units = org_tree::subtree(tx, &[root]).await?;
    let texts: Vec<String> = units.iter().map(Uuid::to_string).collect();
    let scheduled_in: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employee_lifecycle_events \
         WHERE to_org_unit_id = ANY($1) AND state = 'SCHEDULED'",
    )
    .bind(&units)
    .fetch_one(tx.as_mut())
    .await?;
    let members = org_tree::members(tx, &units).await? + scheduled_in;
    // A voided registration still holds the unit's key: count it.
    sqlx::query("SELECT set_config('app.include_voided', 'on', true)")
        .execute(tx.as_mut())
        .await?;
    let people_ever: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM (SELECT id FROM employees WHERE org_unit_id = ANY($1) \
           UNION SELECT employee_id FROM employee_lifecycle_events \
            WHERE to_org_unit_id = ANY($1) OR from_org_unit_id = ANY($1)) x",
    )
    .bind(&units)
    .fetch_one(tx.as_mut())
    .await?;
    sqlx::query("SELECT set_config('app.include_voided', 'off', true)")
        .execute(tx.as_mut())
        .await?;
    let history: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM org_unit_revisions WHERE NOT (org_unit_id = ANY($1)) \
                   AND attributes->>'parent_id' = ANY($2)) \
              + (SELECT count(*) FROM access_grants WHERE org_unit_id = ANY($1)) \
              + (SELECT count(*) FROM change_set_lines WHERE to_org_unit_id = ANY($1)) \
              + (SELECT count(*) FROM job_positions WHERE org_unit_id = ANY($1))",
    )
    .bind(&units)
    .bind(&texts)
    .fetch_one(tx.as_mut())
    .await?;
    let held_by = held_by(tx, &texts).await?;
    Ok(Usage {
        units,
        members,
        people_ever,
        history,
        held_by,
    })
}

/// An org change not yet closed names one of `units` (its target or an op).
pub(crate) async fn open_change(tx: &mut Tx<'_>, units: &[String]) -> Result<bool, PgEntityError> {
    Ok(held_by(tx, units).await?.is_some())
}

/// The oldest org change not yet closed that names one of `units` (its
/// target or an op): the one blocker a held unit names (UX-R3 org-16).
pub(crate) async fn held_by(
    tx: &mut Tx<'_>,
    units: &[String],
) -> Result<Option<(Uuid, String)>, PgEntityError> {
    Ok(sqlx::query_as(
        "SELECT r.id, r.code FROM org_change_requests r \
           WHERE r.status IN ('DRAFT','PRECHECKED','IN_APPROVAL','APPROVED','SETTLING') \
             AND (r.target_ref = ANY($1) \
                  OR EXISTS (SELECT 1 FROM unnest($1::text[]) u WHERE strpos(r.proposal::text, u) > 0)) \
           ORDER BY r.created_at, r.id LIMIT 1",
    )
    .bind(units)
    .fetch_optional(tx.as_mut())
    .await?)
}

/// Why the unit cannot be erased, if it cannot.
pub(crate) fn erase_refusal(u: &Usage) -> Option<&'static str> {
    if u.people_ever > 0 {
        Some("org_unit_has_people_history")
    } else if u.history > 0 {
        Some("org_unit_has_history")
    } else if u.held_by.is_some() {
        Some("org_unit_change_open")
    } else {
        None
    }
}

/// Why the unit cannot be dissolved (폐지), if it cannot. A never-used unit
/// is erased instead, so 폐지 is not offered for it.
pub(crate) fn dissolve_refusal(u: &Usage, routed: bool) -> Option<&'static str> {
    if erase_refusal(u).is_none() {
        Some("org_unit_never_used")
    } else if u.held_by.is_some() {
        // org-16: the change that holds the unit is its one blocker (members are that change's, or the next one's).
        Some("org_unit_change_open")
    } else if u.members > 0 {
        Some("org_unit_has_members")
    } else if routed {
        Some("org_change_routed")
    } else {
        None
    }
}

/// An active 부서 (a 사업장's own unit ends with the 사업장).
pub(crate) async fn department(tx: &mut Tx<'_>, id: Uuid) -> Result<Head, PgEntityError> {
    let head = org_tree::head(tx, id)
        .await?
        .filter(Head::active)
        .ok_or_else(|| Refusal::not_found("org_unit_not_found"))?;
    if head.kind() == "site" {
        return Err(
            Refusal::conflict("site_is_a_workplace", "end the 사업장 instead")
                .with_remedy("void_workplace")
                .into(),
        );
    }
    Ok(head)
}

pub(crate) fn refuse(code: &'static str) -> PgEntityError {
    let (message, remedy) = match code {
        "org_unit_has_people_history" => (
            "people were placed in this unit or moved through it",
            "dissolve_instead",
        ),
        "org_unit_has_history" => ("other records name this unit", "dissolve_instead"),
        "org_unit_change_open" => (
            "an org change not yet closed names this unit",
            "open_org_change",
        ),
        "org_unit_has_members" => (
            "people are placed in this unit or under it",
            "move_people_first",
        ),
        "org_unit_never_used" => (
            "this unit was never used; delete it instead",
            "erase_instead",
        ),
        _ => ("org changes are routed through 결재", "submit_org_change"),
    };
    Refusal::conflict(code, message).with_remedy(remedy).into()
}

/// Admit a direct 부서 write ([`PgEntityStore::run_batch`] with `direct`):
/// SETUP as a setup write; after 운영 시작 GOVERNED, unless the tenant routes
/// org changes or an open org change names a unit the ops touch. A 폐지
/// (`Dissolve`) is refused for a unit nobody ever used (erase it) and while
/// anyone is placed in it or moving into it, in either phase.
pub(crate) async fn admit_direct(
    tx: &mut Tx<'_>,
    actor: &Actor,
    port: &dyn OrgUnitSetupWritePort,
    ops: &[OrgSetupOp],
) -> Result<Admitted, PgEntityError> {
    let phase = read_phase(tx, true).await?;
    let operating = phase == TenantPhase::Operating;
    let routed = operating
        && port
            .org_changes_routed(tx, actor.org)
            .await
            .map_err(Refusal::from)?;
    if routed {
        return Err(refuse("org_change_routed"));
    }
    for op in ops {
        if let OrgSetupOp::Dissolve {
            org_unit_id: Some(id),
            ..
        } = op
        {
            department(tx, *id).await?;
            if let Some(code) = dissolve_refusal(&usage(tx, *id).await?, false) {
                return Err(refuse(code));
            }
        }
    }
    let named: Vec<String> = ops
        .iter()
        .flat_map(crate::org_ops::named_units)
        .map(|u| u.to_string())
        .collect();
    if operating && open_change(tx, &named).await? {
        return Err(refuse("org_unit_change_open"));
    }
    let mode = if operating {
        ChangeMode::Governed
    } else {
        ChangeMode::Setup
    };
    Ok(Admitted { phase, mode })
}
