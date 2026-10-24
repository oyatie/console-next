//! Commands derived from legacy `employees` rows: the org-change reassign
//! transfers and the appointment that binds an unbound legacy head.

use super::error::EmploymentError;
use super::lookups::{employment_id_for_employee, ensure_org_unit_exists};
use super::model::{EmploymentAttributes, EmploymentCommand, EmploymentQuery};
use super::write::write_in_tx;
use console_kernel_core::{OrgId, UserId};
use console_ontology_canonical_domain::{CommandId, CommandReceipt};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction};
use time::{Date, OffsetDateTime, macros::offset};
use uuid::Uuid;

/// Org-change `ReassignOrgUnit` → one `hr.transfer` per matched member.
///
/// `from_org_unit` / `to_org_unit` must be OrgUnit UUID strings (fail closed on
/// free-text team labels). Both source and destination OrgUnits must exist —
/// a syntactically valid but unknown `from` must not audit as `moved=0` success.
/// Members are every non-EXITED row (ACTIVE, ON_LEAVE, UNKNOWN) — the same set
/// the org-change preflight counts as headcount and as the dissolve blocker, so
/// whatever blocks a dissolve can be moved by a reassign. An ON_LEAVE member
/// keeps its status (the Transfer carries it). EXITED heads are never
/// rewritten. Employees without an `employment_source_bindings` row are refused
/// — a bulk rewrite of unbound heads is not a transfer.
#[allow(clippy::too_many_arguments)] // tx + org/actor/op ids + from/to/company/valid_from mirror the apply-op surface
pub async fn reassign_org_unit_via_transfers_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    op_command_id: Uuid,
    from_org_unit: &str,
    to_org_unit: &str,
    valid_from: OffsetDateTime,
) -> Result<u64, EmploymentError> {
    let from_id =
        Uuid::parse_str(from_org_unit.trim()).map_err(|_| EmploymentError::OrgUnitRefNotUuid)?;
    let to_id =
        Uuid::parse_str(to_org_unit.trim()).map_err(|_| EmploymentError::OrgUnitRefNotUuid)?;
    if from_id == to_id {
        return Err(EmploymentError::Blocked(vec![
            "REASSIGN_ORG_UNIT source and target must differ".to_owned(),
        ]));
    }

    // Fail closed on both ends before SELECT — unknown source must not return Ok(0).
    ensure_org_unit_exists(tx, *org.as_uuid(), from_id).await?;
    ensure_org_unit_exists(tx, *org.as_uuid(), to_id).await?;

    let from_text = from_id.to_string();
    // Exactly the members the dissolve headcount and blocker count (no company
    // predicate): every one of them moves, each keeping their own company.
    let rows = sqlx::query(
        "SELECT id, company, position, employment_status FROM employees \
         WHERE org_id = $1 \
           AND (org_unit = $2 OR org_unit_id = $3) \
           AND entity_employed_on(entity_today(), hire_on, exit_on, employment_status)",
    )
    .bind(org.as_uuid())
    .bind(&from_text)
    .bind(from_id)
    .fetch_all(tx.as_mut())
    .await?;

    let mut moved = 0_u64;
    for row in rows {
        let employee_id: Uuid = row.get("id");
        let employment_status: String = row.get("employment_status");
        let company: String = row.get("company");
        let position_text: Option<String> = row.get("position");
        let job_position_id = position_text
            .as_deref()
            .and_then(|value| Uuid::parse_str(value.trim()).ok());

        let employment_id = employment_id_for_employee(tx, *org.as_uuid(), employee_id).await?;
        // Per-employee command id: tenant-global uniqueness + deterministic for
        // the same (apply-op command, employee) pair.
        let command_id = derived_command_id(op_command_id.as_bytes(), employee_id);
        let command = EmploymentCommand {
            org_id: org,
            command_id: CommandId::from_uuid(command_id),
            actor_id: actor,
            query: EmploymentQuery::Transfer {
                employment_id,
                valid_from,
                attributes: EmploymentAttributes {
                    company,
                    org_unit_id: Some(to_id),
                    job_position_id,
                    employment_status,
                },
            },
            action_key: "internal.reassign_org_unit".to_owned(),
            object_type_id: Uuid::nil(),
        };
        write_in_tx(tx, &command).await?;
        moved += 1;
    }
    Ok(moved)
}

/// A deterministic command id for `(seed, employee)`. v5 is not enabled on the
/// workspace uuid crate; SHA-256 truncated to 16 bytes is enough here.
fn derived_command_id(seed: &[u8], employee_id: Uuid) -> Uuid {
    let mut hasher = Sha256::new();
    hasher.update(seed);
    hasher.update(employee_id.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    Uuid::from_bytes(bytes)
}

/// Opens the canonical employment (`hr.appoint`) for a legacy `employees` row
/// that has none, inside the caller's transaction: head + revision 1 + the
/// `employment_source_bindings` row every later Transfer resolves through.
///
/// The directory create (`POST /api/v1/employees`, and a recruiting hire
/// through the same core) and the employee import both write the legacy head
/// only; without this an org-change `ReassignOrgUnit` refuses every one of
/// them as unbound. The state appointed is the row's own: company, the bound
/// OrgUnit (`org_unit_id`, else UUID `org_unit` text), the JobPosition when
/// `position` is a UUID (free-text titles are not canonical authority), and the
/// row's status. It opens on the hire date (KST midnight, never later than
/// now), or now when the row has no readable hire date — so the period-lock
/// gate (§3.9.1) refuses an appointment dated inside a closed window.
///
/// `Ok(None)`: the row is already bound, EXITED, or not visible. The command
/// id is derived from the employee, so a retry replays rather than re-appoints.
///
/// # Errors
/// Whatever [`write_in_tx`] refuses (`Blocked`, `Frozen`, `UnknownOrgUnit`, ...).
pub async fn appoint_legacy_head_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee_id: Uuid,
) -> Result<Option<CommandReceipt>, EmploymentError> {
    let org_uuid = *org.as_uuid();
    let row = sqlx::query(
        "SELECT e.company, e.org_unit, e.org_unit_id, e.position, e.employment_status, \
                e.hire_on, \
                EXISTS (SELECT 1 FROM employment_source_bindings b \
                        WHERE b.org_id = e.org_id AND b.employee_id = e.id) AS bound \
         FROM employees e WHERE e.org_id = $1 AND e.id = $2",
    )
    .bind(org_uuid)
    .bind(employee_id)
    .fetch_optional(tx.as_mut())
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let employment_status: String = row.get("employment_status");
    if row.get::<bool, _>("bound") || employment_status == "EXITED" {
        return Ok(None);
    }
    let uuid_text = |column: &str| {
        row.get::<Option<String>, _>(column)
            .and_then(|text| Uuid::parse_str(text.trim()).ok())
    };
    let now = OffsetDateTime::now_utc();
    let valid_from = row.get::<Option<Date>, _>("hire_on").map_or(now, |date| {
        date.midnight().assume_offset(offset!(+9)).min(now)
    });
    let command = EmploymentCommand {
        org_id: org,
        command_id: CommandId::from_uuid(derived_command_id(b"hr.appoint", employee_id)),
        actor_id: actor,
        query: EmploymentQuery::Appoint {
            employee_id,
            valid_from,
            attributes: EmploymentAttributes {
                company: row
                    .try_get::<Option<String>, _>("company")?
                    .unwrap_or_default(),
                org_unit_id: row
                    .get::<Option<Uuid>, _>("org_unit_id")
                    .or_else(|| uuid_text("org_unit")),
                job_position_id: uuid_text("position"),
                employment_status,
            },
        },
        action_key: "internal.appoint_legacy_head".to_owned(),
        object_type_id: Uuid::nil(),
    };
    write_in_tx(tx, &command).await.map(Some)
}
