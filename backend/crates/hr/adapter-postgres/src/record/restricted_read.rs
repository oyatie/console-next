//! The purposed read of a restricted section (징계, 장애, 보훈). The plain
//! 인사카드 read leaves these sections out, because knowing that such a record
//! exists is itself sensitive (access-model §6.3 item 9). This read needs a
//! `restricted_record_purpose` code, passes the Cedar gate, and writes one
//! audit row per read naming the subject, the section, the entries returned
//! and the purpose — never the values.
//!
//! The shared access writer makes these reads eligible for 접속기록 점검.

use console_hr_domain::record::Section;
use console_kernel_core::AuditEvent;
use console_platform_authz::Principal;
use console_platform_authz::cedar_pbac::actions::employee_restricted_record::Operation;
use console_platform_db::with_audits;
use console_platform_request_context::audit_context::access_log::{AccessRecord, access_event};
use console_settings_domain::code_lists::ValidReason;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::person::bound_person;
use super::read::history_in_tx;
use super::restricted::{RecordPurpose, check_purpose, gate_for};
use super::store;
use super::support::view;
use super::switch::section_states;
use super::{RecordHistory, RecordList};
use crate::directory::access_log::actor_employee_id;
use crate::metrics::record_hr_read;
use crate::{HrError, HrService};

/// Check the purpose and the gate for one subject; the person, if bound.
async fn admit(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
    section: Section,
    purpose: Option<RecordPurpose>,
) -> Result<(Option<Uuid>, ValidReason), HrError> {
    let org = *principal.org_id.as_uuid();
    let person = bound_person(tx, org, employee).await?;
    let purpose = check_purpose(tx, org, purpose).await?;
    gate_for(tx, principal, section, employee, true)
        .await?
        .decide(Operation::Read, employee, person)?;
    Ok((person, purpose))
}

async fn read_audit(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    employee: Uuid,
    section: Section,
    entries: &[Uuid],
    purpose: &ValidReason,
) -> Result<AuditEvent, HrError> {
    let detail = json!({
        "section": section.as_str(),
        "entry_ids": entries,
        "purpose_code": purpose.code,
        "purpose_note": purpose.note,
    });
    let reader = actor_employee_id(tx, principal).await?;
    access_event(
        principal,
        AccessRecord {
            action: "employee.record.restricted_read",
            target_type: "employee",
            target_id: employee.to_string(),
            subject_ids: &[employee],
            reader_subject: reader,
            details: detail,
        },
    )
    .map_err(HrError::from_kernel)
}

impl HrService {
    pub(crate) async fn restricted_records(
        &self,
        principal: Principal,
        employee: Uuid,
        section: Section,
        include_voided: bool,
        purpose: Option<RecordPurpose>,
    ) -> Result<RecordList, HrError> {
        record_hr_read("employee_records_restricted");
        with_audits::<_, _, HrError>(&self.pool.clone(), principal.org_id, move |tx| {
            Box::pin(async move {
                let (person, purpose) = admit(tx, &principal, employee, section, purpose).await?;
                let org = *principal.org_id.as_uuid();
                let sections = section_states(tx).await?;
                let items: Vec<_> = match person {
                    None => Vec::new(),
                    Some(person) => store::load_current(tx, org, &[person], Some(section))
                        .await?
                        .into_iter()
                        .filter(|c| include_voided || !c.voided())
                        .map(view)
                        .collect(),
                };
                let ids: Vec<Uuid> = items.iter().map(|i| i.id).collect();
                let event = read_audit(tx, &principal, employee, section, &ids, &purpose).await?;
                Ok((RecordList { sections, items }, vec![event]))
            })
        })
        .await
    }

    pub(crate) async fn restricted_history(
        &self,
        principal: Principal,
        employee: Uuid,
        section: Section,
        entry: Uuid,
        purpose: Option<RecordPurpose>,
    ) -> Result<RecordHistory, HrError> {
        record_hr_read("employee_record_history_restricted");
        with_audits::<_, _, HrError>(&self.pool.clone(), principal.org_id, move |tx| {
            Box::pin(async move {
                let (_, purpose) = admit(tx, &principal, employee, section, purpose).await?;
                let org = *principal.org_id.as_uuid();
                let history = history_in_tx(tx, org, employee, section, entry).await?;
                let event =
                    read_audit(tx, &principal, employee, section, &[entry], &purpose).await?;
                Ok((history, vec![event]))
            })
        })
        .await
    }
}
