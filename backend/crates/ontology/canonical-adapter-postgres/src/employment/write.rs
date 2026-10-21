//! `write_in_tx`: one Employment command applied inside an armed transaction.

use super::appointment::appoint_in_tx;
use super::change_window::{assert_employment_change_window_open, business_date};
use super::error::EmploymentError;
use super::legacy_head::{EmploymentChange, apply_employment_change, set_employee_org_unit};
use super::lookups::{bound_employee, ensure_attribute_refs, org_unit_name};
use super::model::{EmploymentCommand, EmploymentQuery};
use super::port::PgEmploymentPort;
use super::receipt::{payload_digest, receipt, stored_target};
use console_kernel_core::UserId;
use console_ontology_canonical_domain::{
    CanonicalPort, CanonicalQuery, CommandReceipt, ReceiptOwner,
};
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

/// Apply one Employment command inside a caller-owned, org-armed transaction.
///
/// Org-change `ReassignOrgUnit` uses this so each transfer shares the apply
/// transaction rather than opening a nested connection. Callers must already
/// have set `app.current_org`.
pub async fn write_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: &EmploymentCommand,
) -> Result<CommandReceipt, EmploymentError> {
    let preflight = <PgEmploymentPort as CanonicalPort>::preflight(&command.query);
    if !preflight.is_ok() {
        return Err(EmploymentError::Blocked(preflight.blockers().to_vec()));
    }

    let digest = payload_digest(command);
    let org = *command.org_id.as_uuid();
    let actor = *command.actor_id.as_uuid();
    let command_uuid = *command.command_id.as_uuid();

    if let Some(stored) = sqlx::query(
        "SELECT actor_id, payload_digest, receipt, created_at \
         FROM ont_action_command_receipts WHERE org_id = $1 AND command_id = $2",
    )
    .bind(org)
    .bind(command_uuid)
    .fetch_optional(tx.as_mut())
    .await?
    {
        let stored_digest: Vec<u8> = stored.get("payload_digest");
        if stored_digest != digest {
            return Err(EmploymentError::DigestConflict(command_uuid));
        }
        let result: serde_json::Value = stored.get("receipt");
        let target = stored_target(command_uuid, &result)?;
        let stored_actor: Uuid = stored.get("actor_id");
        let created_at: OffsetDateTime = stored.get("created_at");
        return Ok(receipt(
            command,
            target,
            UserId::from_uuid(stored_actor),
            digest,
            result,
            created_at,
        ));
    }

    ensure_attribute_refs(tx, org, command.query.attributes()).await?;

    let target = command.query.target();
    let valid_from = command.query.valid_from();
    let attributes = command.query.attributes();

    // §3.9.1: every dated mutation is checked, not just the legacy-head rewrite.
    // This covers Appoint and backdated Promote/Transfer too, so a command dated
    // inside a closed Payroll/Accounting window is refused before any insert.
    assert_employment_change_window_open(tx, org, business_date(valid_from)).await?;

    let (employment_id, version, backdated) = match &command.query {
        EmploymentQuery::Appoint { employee_id, .. } => {
            return appoint_in_tx(tx, command, *employee_id, digest).await;
        }
        EmploymentQuery::Promote { employment_id, .. }
        | EmploymentQuery::Transfer { employment_id, .. } => {
            // MAX + 1 under the row's own transaction. A
            // concurrent revise of the same employment loses to
            // UNIQUE (org_id, employment_id, version) with 23505 rather
            // than silently overwriting; add SELECT ... FOR UPDATE on
            // `employment_heads` if that contention is ever measured.
            let next: i64 = sqlx::query_scalar(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM employment_revisions \
                 WHERE org_id = $1 AND employment_id = $2",
            )
            .bind(org)
            .bind(employment_id)
            .fetch_one(tx.as_mut())
            .await?;
            // A revise before the head's opening bound is outside the
            // employment's half-open lifetime and must be refused, not appended
            // as history. `employment_heads.valid_from` is that opening bound.
            let opened: OffsetDateTime = sqlx::query_scalar(
                "SELECT valid_from FROM employment_heads \
                 WHERE org_id = $1 AND id = $2",
            )
            .bind(org)
            .bind(employment_id)
            .fetch_one(tx.as_mut())
            .await?;
            if valid_from < opened {
                return Err(EmploymentError::Blocked(vec![
                    "revision valid_from predates the employment head opening".to_owned(),
                ]));
            }
            // A revision backdated before the current head is a legitimate
            // history insert (0214 is append-only), but the legacy `employees`
            // head is a projection of the LATEST effective state, so the live
            // rewrite below must be skipped for it. `valid_from` was read
            // before this command's revision is appended, so MAX(valid_from)
            // still names the previous head.
            let latest: Option<OffsetDateTime> = sqlx::query_scalar(
                "SELECT MAX(valid_from) FROM employment_revisions \
                 WHERE org_id = $1 AND employment_id = $2",
            )
            .bind(org)
            .bind(employment_id)
            .fetch_one(tx.as_mut())
            .await?;
            (
                *employment_id,
                next,
                latest.is_some_and(|latest| valid_from < latest),
            )
        }
    };

    let result = serde_json::json!({
        "employment_id": employment_id.to_string(),
        "version": version,
        "target": target.as_str(),
    });

    let created_at: OffsetDateTime = sqlx::query_scalar(
        "INSERT INTO employment_revisions \
         (org_id, employment_id, version, command_id, actor_id, payload_digest, \
          valid_from, attributes, receipt) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING created_at",
    )
    .bind(org)
    .bind(employment_id)
    .bind(version)
    .bind(command_uuid)
    .bind(actor)
    .bind(digest.as_slice())
    .bind(valid_from)
    .bind(attributes.to_json())
    .bind(&result)
    .fetch_one(tx.as_mut())
    .await?;

    // The live legacy projection still follows only the latest effective revision.
    // The source binding must resolve for every revise — backdated or
    // not — so a deleted or ambiguous binding cannot append a revision
    // (or store a receipt) that the legacy head could never show.
    let employee_id = bound_employee(tx, org, employment_id).await?;
    if !backdated {
        // The legacy head mirrors the LATEST effective state. Its date
        // string is the KST business date, the same instant the top-of-
        // write gate froze on, so the two never disagree about which
        // calendar day is sealed.
        let effective_date = business_date(valid_from).to_string();
        let org_unit_text = attributes.legacy_org_unit_text();
        let position_text = attributes.legacy_position_text();
        apply_employment_change(
            tx,
            org,
            employee_id,
            EmploymentChange {
                company: &attributes.company,
                org_unit: org_unit_text.as_deref(),
                position: position_text.as_deref(),
                employment_status: &attributes.employment_status,
                effective_date: &effective_date,
            },
        )
        .await?;
        // Keep the 0242 binding in step with the canonical attribute,
        // and the read-only `org_unit` text on the unit's name when it
        // has one (a unit with no named revision keeps the UUID text).
        let name = match attributes.org_unit_id {
            Some(id) => org_unit_name(tx, org, id).await?,
            None => None,
        };
        set_employee_org_unit(
            tx,
            org,
            employee_id,
            attributes.org_unit_id,
            name.as_deref(),
        )
        .await?;
        if attributes.employment_status == "EXITED" {
            sqlx::query(
                "UPDATE employment_heads SET valid_to = $3 \
                 WHERE org_id = $1 AND id = $2",
            )
            .bind(org)
            .bind(employment_id)
            .bind(valid_from)
            .execute(tx.as_mut())
            .await?;
        }
    }

    // The receipt store, and with it the tenant-global command-id namespace
    // this port shares with every other receipt owner.
    // Attribute the receipt to the object whose action it records.
    //
    // DERIVED from the command's own query, which already implements
    // `dispatch_target()` -- the same value the projected-dispatch path uses.
    // NOT from `action_key`: that is "unique only per object type" (a bare
    // "revise"), so it cannot name a target on its own, and the internal
    // reassign path carries "internal.reassign_org_unit", which names none at
    // all. The query knows; the string does not.
    //
    // Without this the row takes the `owner` DEFAULT of 'ontology.action',
    // filing a canonical receipt under the pre-existing instance-action path
    // -- a wrong attribution recorded as fact.
    let receipt_target = command.query.dispatch_target();
    let receipt_owner = ReceiptOwner::Canonical(receipt_target.object());
    sqlx::query(
        "INSERT INTO ont_action_command_receipts \
         (org_id, command_id, actor_id, payload_digest, receipt, action_key, object_type_id, created_at, owner, target) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(org)
    .bind(command_uuid)
    .bind(actor)
    .bind(digest.as_slice())
    .bind(&result)
    .bind(&command.action_key)
        .bind(command.object_type_id)
    .bind(created_at)
    .bind(receipt_owner.as_str())
    .bind(receipt_target.as_str())
    .execute(tx.as_mut())
    .await?;

    Ok(receipt(
        command,
        target,
        command.actor_id,
        digest,
        result,
        created_at,
    ))
}
