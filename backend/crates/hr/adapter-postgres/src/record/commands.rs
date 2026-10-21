//! One-by-one create, correct (UPDATE) and void. Each is idempotent on the
//! request's Idempotency-Key, stored as the revision's `command_id`: the same
//! key and payload replays (200), the same key with another payload is 409.

use console_hr_domain::record::{RecordFields, RevisionKind, Section, validate_reason};
use console_kernel_core::{AuditEvent, KernelError};
use console_platform_authz::cedar_pbac::actions::employee_restricted_record::Operation;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::person::writable_person;
use super::restricted::restricted_gate;
use super::store;
use super::store_write::{NewRevision, insert_revision};
use super::support::{audit, current, digest, replay, single_entry_exists, target, view};
use super::switch::require_enabled;
use super::{
    CreateRecordRequest, RecordEntryView, UpdateRecordRequest, VoidRecordRequest, parse_fields,
};
use crate::authz::{authorize_hr_person, hr_reach};
use crate::{HrError, HrService};

/// The write shared by the three commands, after the checks.
struct Write<'a> {
    principal: &'a Principal,
    employee: Uuid,
    action: &'static str,
}

async fn append(
    tx: &mut Transaction<'_, Postgres>,
    w: &Write<'_>,
    rev: NewRevision<'_>,
) -> Result<((RecordEntryView, bool), Vec<AuditEvent>), HrError> {
    let org = *w.principal.org_id.as_uuid();
    let (entry_id, version, section) = (rev.entry_id, rev.version, rev.fields.section());
    insert_revision(tx, org, rev).await?;
    let detail = json!({ "section": section.as_str(), "entry_id": entry_id, "version": version });
    let event = audit(
        w.principal.org_id,
        w.principal.user_id,
        w.action,
        ("employee", w.employee),
        detail,
    )?;
    Ok(((view(current(tx, org, entry_id).await?), true), vec![event]))
}

impl HrService {
    /// Returns the entry and whether it was created now (201) or replayed (200).
    pub async fn create_record(
        &self,
        principal: Principal,
        employee: Uuid,
        section: Section,
        command: Uuid,
        request: CreateRecordRequest,
    ) -> Result<(RecordEntryView, bool), HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let fields = parse_fields(section, request.fields)?;
        let digest = digest(&json!({ "op": "create", "employee": employee, "fields": fields }));
        with_audits::<_, _, HrError>(&self.pool.clone(), principal.org_id, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee)
                    .await?;
                let org = *principal.org_id.as_uuid();
                if section.restricted() {
                    restricted_gate(tx, &principal, section, employee, Operation::Write).await?;
                }
                if let Some(stored) = replay(tx, org, command, &digest).await? {
                    return Ok(((stored, false), Vec::new()));
                }
                require_enabled(tx, section).await?;
                let person =
                    writable_person(tx, principal.org_id, principal.user_id, employee).await?;
                if section.single_live() {
                    let live = store::load_current(tx, org, &[person], Some(section)).await?;
                    if live.iter().any(|c| !c.voided()) {
                        return Err(single_entry_exists(section));
                    }
                }
                let actor = *principal.user_id.as_uuid();
                let entry_id = store::insert_entry(tx, org, person, section, actor).await?;
                let w = Write {
                    principal: &principal,
                    employee,
                    action: "employee.record.create",
                };
                let rev = NewRevision {
                    entry_id,
                    version: 1,
                    kind: RevisionKind::Create,
                    command_id: command,
                    digest: &digest,
                    reason: None,
                    batch: None,
                    actor,
                    fields: &fields,
                };
                append(tx, &w, rev).await
            })
        })
        .await
    }

    /// A correction: the whole new snapshot as the next version. Equal values
    /// write nothing and answer the entry as it stands (200).
    pub async fn update_record(
        &self,
        principal: Principal,
        employee: Uuid,
        section: Section,
        entry: Uuid,
        command: Uuid,
        request: UpdateRecordRequest,
    ) -> Result<(RecordEntryView, bool), HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let fields = parse_fields(section, request.fields)?;
        let reason = validate_reason(request.reason, false)?;
        let expected = request.expected_version;
        let digest = digest(
            &json!({ "op": "update", "employee": employee, "entry": entry,
            "expected_version": expected, "fields": fields, "reason": reason }),
        );
        with_audits::<_, _, HrError>(&self.pool.clone(), principal.org_id, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee)
                    .await?;
                let org = *principal.org_id.as_uuid();
                if section.restricted() {
                    restricted_gate(tx, &principal, section, employee, Operation::Write).await?;
                }
                if let Some(stored) = replay(tx, org, command, &digest).await? {
                    return Ok(((stored, false), Vec::new()));
                }
                require_enabled(tx, section).await?;
                let person =
                    writable_person(tx, principal.org_id, principal.user_id, employee).await?;
                let found = target(tx, org, person, section, entry, expected).await?;
                if found.voided() {
                    return Err(HrError::from_kernel(KernelError::invalid_transition(
                        "a voided entry cannot be corrected; record a new entry",
                    )));
                }
                if found.head.fields == fields {
                    return Ok(((view(found), false), Vec::new()));
                }
                let actor = *principal.user_id.as_uuid();
                let w = Write {
                    principal: &principal,
                    employee,
                    action: "employee.record.update",
                };
                let rev = NewRevision {
                    entry_id: entry,
                    version: expected + 1,
                    kind: RevisionKind::Update,
                    command_id: command,
                    digest: &digest,
                    reason: reason.as_deref(),
                    batch: None,
                    actor,
                    fields: &fields,
                };
                append(tx, &w, rev).await
            })
        })
        .await
    }

    /// Void: the entry leaves the 인사카드 and keeps its history. Works with
    /// the section switched off, so collected data can still be retired.
    pub async fn void_record(
        &self,
        principal: Principal,
        employee: Uuid,
        section: Section,
        entry: Uuid,
        command: Uuid,
        request: VoidRecordRequest,
    ) -> Result<(RecordEntryView, bool), HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let reason = validate_reason(Some(request.reason), true)?;
        let expected = request.expected_version;
        let digest = digest(&json!({ "op": "void", "employee": employee, "entry": entry,
            "expected_version": expected, "reason": reason }));
        with_audits::<_, _, HrError>(&self.pool.clone(), principal.org_id, move |tx| {
            Box::pin(async move {
                authorize_hr_person(tx, &principal, Feature::EmployeeDirectoryManage, employee)
                    .await?;
                let org = *principal.org_id.as_uuid();
                if section.restricted() {
                    restricted_gate(tx, &principal, section, employee, Operation::Void).await?;
                }
                if let Some(stored) = replay(tx, org, command, &digest).await? {
                    return Ok(((stored, false), Vec::new()));
                }
                let person =
                    writable_person(tx, principal.org_id, principal.user_id, employee).await?;
                let found = target(tx, org, person, section, entry, expected).await?;
                if found.voided() {
                    return Ok(((view(found), false), Vec::new()));
                }
                let fields: RecordFields = found.head.fields.clone();
                let actor = *principal.user_id.as_uuid();
                let w = Write {
                    principal: &principal,
                    employee,
                    action: "employee.record.void",
                };
                let rev = NewRevision {
                    entry_id: entry,
                    version: expected + 1,
                    kind: RevisionKind::Void,
                    command_id: command,
                    digest: &digest,
                    reason: reason.as_deref(),
                    batch: None,
                    actor,
                    fields: &fields,
                };
                append(tx, &w, rev).await
            })
        })
        .await
    }
}
