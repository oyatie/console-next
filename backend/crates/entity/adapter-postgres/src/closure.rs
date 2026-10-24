//! Close instead of delete (decisions #21): MR-14 a 사업장 폐업 (a revision
//! with status CLOSED sets `workplaces.closed_on`; a later CONTINUING one
//! reopens it) and MR-15 a 법인 해산/폐업 (its open 사업장 and 사업자등록 close
//! with it). Both are refused while people or 부서 remain; 0264 refuses any
//! later placement past the close.

use console_entity_application::Actor;
use console_entity_domain::Refusal;
use console_entity_domain::codes::OperatingStatus;
use console_kernel_core::{UserId, WriteClass};
use uuid::Uuid;

use crate::org_units::OrgUnitSetupWritePort;
use crate::revision_copy::{Copy, RevisionAt, append_copy};
use crate::site_unit::{dissolve_sites, workplace_unit};
use crate::{Admitted, PgEntityError, Tx, admit};

/// Refuse while anyone not EXITED is placed at the 사업장 `id` (or anywhere in
/// the 법인 `id` when `whole_entity`) past `on`, sits in its own SITE unit, or
/// while 부서 hang under it.
pub(crate) async fn ensure_vacant(
    tx: &mut Tx<'_>,
    whole_entity: bool,
    id: Uuid,
    on: time::Date,
) -> Result<(), PgEntityError> {
    let (people, units): (i64, i64) = sqlx::query_as(
        "WITH places AS (SELECT w.id FROM workplaces w WHERE w.id = $1 OR $2 AND w.legal_entity_id = $1), \
              sites AS (SELECT p.org_unit_id FROM org_unit_placements p \
                WHERE p.valid_to IS NULL AND p.represents_workplace AND p.workplace_id IN (SELECT id FROM places)) \
         SELECT (SELECT count(DISTINCT x) FROM ( \
                   SELECT a.employee_id AS x FROM employment_assignments a JOIN employees e ON e.id = a.employee_id \
                    WHERE a.superseded_at IS NULL AND a.valid_from <= $3 AND (a.valid_to IS NULL OR a.valid_to > $3) AND entity_employed_on($3, e.hire_on, e.exit_on, e.employment_status) \
                      AND (a.workplace_id IN (SELECT id FROM places) OR $2 AND a.legal_entity_id = $1) \
                   UNION SELECT e.id FROM employees e \
                    WHERE e.org_unit_id IN (SELECT org_unit_id FROM sites) AND entity_employed_on($3, e.hire_on, e.exit_on, e.employment_status)) people), \
                (SELECT count(*) FROM org_unit_placements p WHERE p.valid_to IS NULL AND NOT p.represents_workplace \
                   AND (p.workplace_id IN (SELECT id FROM places) OR $2 AND p.legal_entity_id = $1)) \
                + (SELECT count(*) FROM (SELECT DISTINCT ON (r.org_unit_id) r.attributes FROM org_unit_revisions r \
                     ORDER BY r.org_unit_id, r.version DESC) h \
                   WHERE h.attributes->>'status' IS DISTINCT FROM 'dissolved' \
                     AND h.attributes->>'parent_id' IN (SELECT org_unit_id::text FROM sites))",
    )
    .bind(id)
    .bind(whole_entity)
    .bind(on)
    .fetch_one(tx.as_mut())
    .await?;
    if people == 0 && units == 0 {
        return Ok(());
    }
    let remedy = if people > 0 {
        "move_people_first"
    } else {
        "move_or_dissolve_units_first"
    };
    Err(Refusal::conflict(
        "record_in_use",
        format!("{people} people and {units} org units are still there"),
    )
    .with_remedy(remedy)
    .into())
}

/// One command writes one revision per record (`UNIQUE (org_id, command_id)`):
/// each closed record gets the command id mixed with its own id.
pub(crate) fn per_record(command: Uuid, record: Uuid) -> Uuid {
    Uuid::from_u128(command.as_u128() ^ record.as_u128())
}

/// Close one 사업장 inside the caller's transaction: a CLOSED revision and
/// `workplaces.closed_on`. This is what the orgchange `WorkplaceClosePort`
/// wraps (`CLOSE_WORKPLACE`, whose settlement has already moved or exited the
/// people and which dissolves the SITE unit itself). Already closed or voided
/// is a conflict.
///
/// # Errors
/// `workplace_not_found`, `workplace_voided`, `workplace_already_closed`, or database faults.
pub async fn close_workplace_in_tx(
    tx: &mut Tx<'_>,
    actor: UserId,
    command: Uuid,
    workplace: Uuid,
    closed_on: time::Date,
) -> Result<(), PgEntityError> {
    let admitted = admit(tx, WriteClass::EntityStructure).await?;
    crate::workplace::lock_workplace(tx, workplace).await?;
    let closed: Option<time::Date> =
        sqlx::query_scalar("SELECT closed_on FROM workplaces WHERE id = $1")
            .bind(workplace)
            .fetch_one(tx.as_mut())
            .await?;
    if closed.is_some() {
        return Err(Refusal::conflict(
            "workplace_already_closed",
            "the workplace is already closed",
        )
        .into());
    }
    close_one(
        tx,
        false,
        workplace,
        closed_on,
        console_entity_domain::SystemReason::WorkplaceClosed.as_str(),
        admitted,
        actor,
        // One apply may close several 사업장 under one command id.
        per_record(command, workplace),
    )
    .await
}

#[allow(clippy::too_many_arguments)] // one record, its date and the write's provenance
pub(crate) async fn close_one(
    tx: &mut Tx<'_>,
    registration: bool,
    id: Uuid,
    closed_on: time::Date,
    reason: &str,
    admitted: Admitted,
    actor: UserId,
    command: Uuid,
) -> Result<(), PgEntityError> {
    let at = RevisionAt {
        admitted,
        actor,
        command,
    };
    append_copy(tx, registration, id, Copy::Closed(closed_on), reason, at).await?;
    let sql = if registration {
        "UPDATE business_registrations SET closed_on = $2 WHERE id = $1"
    } else {
        "UPDATE workplaces SET closed_on = $2 WHERE id = $1"
    };
    sqlx::query(sql)
        .bind(id)
        .bind(closed_on)
        .execute(tx.as_mut())
        .await?;
    Ok(())
}

/// After a 사업장 revision (MR-14): CLOSED sets `closed_on` to its 폐업일 once
/// the 사업장 is empty and holds no 법인 role or shared registration, and
/// dissolves its SITE unit; any other status on a closed 사업장 reopens it
/// (a correction, kept in the revision history) with a new SITE unit.
#[allow(clippy::too_many_arguments)] // the revise's own context, passed through
pub(crate) async fn apply_workplace_status(
    tx: &mut Tx<'_>,
    actor: &Actor,
    id: Uuid,
    entity: Uuid,
    status: OperatingStatus,
    since: Option<time::Date>,
    today: time::Date,
    admitted: Admitted,
    port: &dyn OrgUnitSetupWritePort,
) -> Result<(), PgEntityError> {
    let closed: Option<time::Date> =
        sqlx::query_scalar("SELECT closed_on FROM workplaces WHERE id = $1")
            .bind(id)
            .fetch_one(tx.as_mut())
            .await?;
    match (status, since, closed) {
        (OperatingStatus::Closed, Some(on), None) => {
            ensure_vacant(tx, false, id, on).await?;
            ensure_holds_nothing(tx, entity, id).await?;
            sqlx::query("UPDATE workplaces SET closed_on = $2 WHERE id = $1")
                .bind(id)
                .bind(on)
                .execute(tx.as_mut())
                .await?;
            dissolve_sites(tx, actor, "workplace_id", id, today, port).await
        }
        (OperatingStatus::Closed, Some(on), Some(_)) => {
            sqlx::query("UPDATE workplaces SET closed_on = $2 WHERE id = $1")
                .bind(id)
                .bind(on)
                .execute(tx.as_mut())
                .await?;
            Ok(())
        }
        (OperatingStatus::Closed, None, _) | (_, _, None) => Ok(()),
        (_, _, Some(_)) => {
            sqlx::query("UPDATE workplaces SET closed_on = NULL WHERE id = $1")
                .bind(id)
                .execute(tx.as_mut())
                .await?;
            workplace_unit(tx, actor, id, today, admitted, port)
                .await
                .map(|_| ())
        }
    }
}

/// A 사업장 that is the 법인's 대표/본점 사업장, or holds a 사업자등록 others
/// still file under, does not close alone.
async fn ensure_holds_nothing(
    tx: &mut Tx<'_>,
    entity: Uuid,
    id: Uuid,
) -> Result<(), PgEntityError> {
    let (role, others, filers): (bool, i64, i64) = sqlx::query_as(
        "SELECT (e.primary_workplace_id = $2 OR e.head_office_workplace_id = $2) IS TRUE, \
                (SELECT count(*) FROM workplaces w WHERE w.legal_entity_id = $1 AND w.id <> $2 \
                   AND w.voided_at IS NULL AND w.closed_on IS NULL), \
                (SELECT count(*) FROM business_registrations r JOIN workplaces w ON w.registration_id = r.id \
                  WHERE r.holder_workplace_id = $2 AND w.id <> $2 AND w.voided_at IS NULL AND w.closed_on IS NULL) \
         FROM legal_entities e WHERE e.id = $1",
    )
    .bind(entity)
    .bind(id)
    .fetch_one(tx.as_mut())
    .await?;
    if role {
        let remedy = if others > 0 {
            "change_entity_roles_first"
        } else {
            "close_legal_entity"
        };
        return Err(Refusal::conflict(
            "workplace_holds_entity_role",
            "the workplace is the 대표 or 본점 사업장",
        )
        .with_remedy(remedy)
        .into());
    }
    if filers > 0 {
        return Err(Refusal::conflict(
            "registration_holder_in_use",
            format!("{filers} other workplaces file under the registration this workplace holds"),
        )
        .with_remedy("move_workplaces_first")
        .into());
    }
    Ok(())
}

/// A 사업자등록 does not close while open 사업장 still file under it (each
/// would be left on a closed registration it cannot be revised against).
pub(crate) async fn ensure_registration_closable(
    tx: &mut Tx<'_>,
    registration: Uuid,
) -> Result<(), PgEntityError> {
    let open: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workplaces WHERE registration_id = $1 AND voided_at IS NULL AND closed_on IS NULL",
    )
    .bind(registration)
    .fetch_one(tx.as_mut())
    .await?;
    if open > 0 {
        return Err(Refusal::conflict(
            "record_in_use",
            format!("{open} open workplaces file under this registration"),
        )
        .with_remedy("close_workplaces_first")
        .into());
    }
    Ok(())
}
