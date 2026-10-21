//! UX-R2 ENDS: the writes of a 사업장 close job (see `workplace_close_plan`):
//! move or dissolve a 부서 through the canonical OrgUnit owner, close the
//! 사업장 as a direct close does, and the job's audit and idempotency rows.

use console_entity_application::{Actor, EntityScope};
use console_entity_domain::Refusal;
use console_entity_domain::codes::OperatingStatus;
use console_kernel_core::{AuditEvent, OrgId, TraceContext, UserId, WriteClass};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::closure::{apply_workplace_status, close_one, per_record};
use crate::command::{Outcome, claim, finish};
use crate::org_tree;
use crate::org_units::{OrgUnitSetupWritePort, port_refusal};
use crate::workplace_close_plan::CloseScope;
use crate::{PgEntityError, Tx, admit, audit, today_kst};

/// Who writes: the planner (the job's actor) and the job's command id.
#[derive(Debug, Clone, Copy)]
pub struct CloseActor {
    pub org: OrgId,
    pub user: UserId,
    pub command: Uuid,
}

impl CloseActor {
    fn actor(self) -> Actor {
        Actor {
            org: self.org,
            user: self.user,
            trace: TraceContext::generate(),
            command_id: Some(self.command),
            scope: EntityScope::Tenant,
        }
    }
}

/// Move the 부서 `unit` (and everything under it) under `parent`, effective
/// today, through the canonical OrgUnit owner. Its people are not rebound
/// here: their 전근 events are, before this runs.
///
/// # Errors
/// `org_unit_not_found`, the owner's refusal, or database faults.
pub async fn reparent(
    tx: &mut Tx<'_>,
    who: CloseActor,
    unit: Uuid,
    parent: Uuid,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<AuditEvent, PgEntityError> {
    org_tree::lock_units(tx, &[unit, parent]).await?;
    let head = org_tree::head(tx, unit)
        .await?
        .filter(org_tree::Head::active)
        .ok_or_else(|| Refusal::not_found("org_unit_not_found"))?;
    let today = today_kst(tx).await?;
    let mut attributes = head.attributes.clone();
    attributes["parent_id"] = json!(parent.to_string());
    attributes["effective_from"] = json!(today.to_string());
    write(tx, who, unit, attributes, port).await?;
    unit_event(
        tx,
        who,
        "org_unit.close_move",
        unit,
        json!({ "parent_id": parent }),
    )
    .await
}

/// Dissolve the 부서 `unit` and everything under it (deepest first), today.
/// 409 `org_unit_has_members` while anyone who has not left is placed there.
///
/// # Errors
/// That refusal, the owner's, or database faults.
pub async fn dissolve(
    tx: &mut Tx<'_>,
    who: CloseActor,
    unit: Uuid,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<AuditEvent, PgEntityError> {
    let units = org_tree::subtree(tx, &[unit]).await?;
    org_tree::lock_units(tx, &units).await?;
    let people = org_tree::members(tx, &units).await?;
    if people > 0 {
        return Err(Refusal::conflict(
            "org_unit_has_members",
            format!("{people} people who have not left are placed in org unit {unit} or under it"),
        )
        .with_remedy("move_people_first")
        .into());
    }
    let today = today_kst(tx).await?;
    for id in &units {
        let Some(head) = org_tree::head(tx, *id).await? else {
            continue;
        };
        let mut attributes = head.attributes;
        attributes["status"] = json!("dissolved");
        attributes["effective_from"] = json!(today.to_string());
        write(tx, who, *id, attributes, port).await?;
    }
    unit_event(
        tx,
        who,
        "org_unit.close_dissolve",
        unit,
        json!({ "units": units }),
    )
    .await
}

async fn write(
    tx: &mut Tx<'_>,
    who: CloseActor,
    unit: Uuid,
    attributes: Value,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<(), PgEntityError> {
    port.write(
        tx,
        who.org,
        who.user,
        Uuid::new_v4(),
        Some(unit),
        attributes,
    )
    .await
    .map(drop)
    .map_err(port_refusal)
}

async fn unit_event(
    tx: &mut Tx<'_>,
    who: CloseActor,
    action: &str,
    unit: Uuid,
    after: Value,
) -> Result<AuditEvent, PgEntityError> {
    let admitted = admit(tx, WriteClass::EntityStructure).await?;
    audit(&who.actor(), action, "org_unit", unit, admitted, after)
}

/// Close the 사업장 on `on`: refused while anyone or any 부서 is still there
/// (`record_in_use`) or while it is the 법인's 대표 사업장 or 본점
/// (`workplace_holds_entity_role`); otherwise `closed_on`, a CLOSED revision
/// and its SITE unit dissolved, as a direct close does.
///
/// # Errors
/// Those refusals, or database faults.
pub async fn close(
    tx: &mut Tx<'_>,
    who: CloseActor,
    scope: &CloseScope,
    on: time::Date,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<(), PgEntityError> {
    let admitted = admit(tx, WriteClass::EntityStructure).await?;
    let today = today_kst(tx).await?;
    let actor = who.actor();
    let id = scope.workplace_id;
    apply_workplace_status(
        tx,
        &actor,
        id,
        scope.legal_entity_id,
        OperatingStatus::Closed,
        Some(on),
        today,
        admitted,
        port,
    )
    .await?;
    close_one(
        tx,
        false,
        id,
        on,
        console_entity_domain::SystemReason::WorkplaceClosed.as_str(),
        admitted,
        who.user,
        per_record(who.command, id),
    )
    .await
}

/// The job's audit event (`workplace.close_plan`, `workplace.close_job.*`).
///
/// # Errors
/// Database faults.
pub async fn job_event(
    tx: &mut Tx<'_>,
    who: CloseActor,
    action: &str,
    workplace: Uuid,
    after: Value,
) -> Result<AuditEvent, PgEntityError> {
    let admitted = admit(tx, WriteClass::EntityStructure).await?;
    audit(
        &who.actor(),
        action,
        "workplace",
        workplace,
        admitted,
        after,
    )
    .map(|event| event.with_source(console_kernel_core::AuditSource::Scheduler))
}

/// Claim the planning request's Idempotency-Key (`entity_commands`).
/// `Some(job)`: it already ran; answer with that job.
///
/// # Errors
/// 409 `idempotency_key_reused`, or database faults.
pub async fn claim_plan(
    tx: &mut Tx<'_>,
    who: CloseActor,
    request: Value,
) -> Result<Option<Uuid>, PgEntityError> {
    Ok(claim(tx, &who.actor(), "workplace.close_plan", request)
        .await?
        .and_then(|o| o.target))
}

/// Record the job a claimed request created, for its replays.
///
/// # Errors
/// Database faults.
pub async fn finish_plan(tx: &mut Tx<'_>, who: CloseActor, job: Uuid) -> Result<(), PgEntityError> {
    finish(
        tx,
        &who.actor(),
        &Outcome {
            target: Some(job),
            change_mode: None,
            count: None,
        },
    )
    .await
}
