//! The gate of the restricted sections (징계, 장애, 보훈; MR-33/35): every
//! fact of the `employee_restricted_record` Cedar action, computed in the
//! use-case transaction, and the read purpose (reason domain
//! `restricted_record_purpose`). Cedar decides; nothing here permits.

use console_hr_domain::import::rrn::is_rrn_value;
use console_hr_domain::record::Section;
use console_platform_authz::cedar_pbac::actions::employee_restricted_record::{
    Operation, RestrictedRecordFacts, decide,
};
use console_platform_authz::{Feature, Principal};
use console_settings_domain::code_lists::{
    ReasonDomain, TenantCode, ValidReason, is_tenant_code, validate_reason,
};
use http::StatusCode;
use serde::Deserialize;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::person::bound_person;
use super::switch::{disabled, enabled};
use crate::HrError;
use crate::authz::{authorize_hr_org_wide, hr_may_person};

/// Why a restricted section is being read: a `restricted_record_purpose`
/// code, and a note when the code asks for one (OTHER).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RecordPurpose {
    pub code: String,
    #[serde(default)]
    pub note: Option<String>,
}

fn refused(status: StatusCode, code: &'static str, message: &str) -> HrError {
    HrError {
        status,
        code,
        message: message.to_owned(),
        refusals: None,
    }
}

/// Check a read purpose against the system codes and the tenant's active
/// codes of the domain.
///
/// the tenant-code SELECT mirrors settings-adapter
/// `validate_reason_in_tx` (hr-adapter → settings-adapter is an illegal
/// edge, as in `switch.rs`); ADR-006 moves it to platform-db.
pub(crate) async fn check_purpose(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    purpose: Option<RecordPurpose>,
) -> Result<ValidReason, HrError> {
    let Some(purpose) = purpose else {
        return Err(refused(
            StatusCode::UNPROCESSABLE_ENTITY,
            "record_purpose_required",
            "reading a restricted section needs a purpose code",
        ));
    };
    let domain = ReasonDomain::RestrictedRecordPurpose;
    let mut tenant = Vec::new();
    if is_tenant_code(&purpose.code) {
        let row = sqlx::query(
            "SELECT requires_note, active FROM reason_codes WHERE org_id = $1 AND domain = $2 AND code = $3",
        )
        .bind(org)
        .bind(domain.as_str())
        .bind(&purpose.code)
        .fetch_optional(tx.as_mut())
        .await?;
        if let Some(row) = row {
            tenant.push(TenantCode {
                code: purpose.code.clone(),
                requires_note: row.try_get("requires_note")?,
                active: row.try_get("active")?,
                involuntary: false,
                notice_required: false,
            });
        }
    }
    let valid = validate_reason(domain, &purpose.code, purpose.note.as_deref(), &tenant)
        .map_err(|e| refused(StatusCode::UNPROCESSABLE_ENTITY, e.code(), &e.to_string()))?;
    if valid.note.as_deref().is_some_and(is_rrn_value) {
        return Err(HrError::validation(
            "the purpose note must not hold a resident or foreigner registration number",
        ));
    }
    Ok(valid)
}

/// The facts that do not depend on the subject, loaded once per request.
pub(crate) struct Gate {
    section: Section,
    actor: String,
    org: String,
    actor_manages_directory: bool,
    section_enabled: bool,
    purpose_given: bool,
    /// The actor's own employee record and its person (users.employee_id).
    own: (Option<Uuid>, Option<Uuid>),
}

pub(crate) async fn gate(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    section: Section,
    purpose_given: bool,
) -> Result<Gate, HrError> {
    let org = *principal.org_id.as_uuid();
    let own = sqlx::query(
        "SELECT u.employee_id, b.person_id FROM users u LEFT JOIN employee_person_bindings b \
         ON b.org_id = u.org_id AND b.employee_id = u.employee_id WHERE u.org_id = $1 AND u.id = $2",
    )
    .bind(org)
    .bind(principal.user_id.as_uuid())
    .fetch_optional(tx.as_mut())
    .await?;
    let own = match own {
        Some(row) => (row.try_get("employee_id")?, row.try_get("person_id")?),
        None => (None, None),
    };
    Ok(Gate {
        section,
        actor: principal.user_id.to_string(),
        org: org.to_string(),
        actor_manages_directory: authorize_hr_org_wide(principal, Feature::EmployeeDirectoryManage)
            .is_ok(),
        section_enabled: enabled(tx, section).await?,
        purpose_given,
        own,
    })
}

/// [`gate`] for one subject: 인사기본 등록·수정 is decided over the grant
/// set on this person (AX-5), not over the whole tenant.
pub(crate) async fn gate_for(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    section: Section,
    employee: Uuid,
    purpose_given: bool,
) -> Result<Gate, HrError> {
    let mut g = gate(tx, principal, section, purpose_given).await?;
    let manage = Feature::EmployeeDirectoryManage;
    g.actor_manages_directory = hr_may_person(tx, principal, manage, employee).await?;
    Ok(g)
}

impl Gate {
    /// Cedar's answer for one subject. A deny (or any evaluation error) is a 403.
    pub(crate) fn decide(
        &self,
        operation: Operation,
        employee: Uuid,
        person: Option<Uuid>,
    ) -> Result<(), HrError> {
        let subject_is_self = self.own.0 == Some(employee)
            || (person.is_some() && (self.own.1 == person || self.own.0 == person));
        let facts = RestrictedRecordFacts {
            operation,
            actor_manages_directory: self.actor_manages_directory,
            subject_is_self,
            section_enabled: self.section_enabled,
            purpose_given: self.purpose_given,
        };
        if decide(&self.actor, &self.org, facts) == Ok(true) {
            return Ok(());
        }
        Err(if subject_is_self {
            refused(
                StatusCode::FORBIDDEN,
                "record_restricted_self",
                "nobody handles a restricted section of their own record",
            )
        } else if operation == Operation::Write && !self.section_enabled {
            disabled(self.section)
        } else {
            refused(
                StatusCode::FORBIDDEN,
                "record_restricted_forbidden",
                "this restricted section cannot be handled with your access",
            )
        })
    }
}

/// The write-side gate of one command, before any replay answers: a
/// restricted entry is never echoed to an actor Cedar refuses.
pub(crate) async fn restricted_gate(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    section: Section,
    employee: Uuid,
    operation: Operation,
) -> Result<(), HrError> {
    let person = bound_person(tx, *principal.org_id.as_uuid(), employee).await?;
    gate_for(tx, principal, section, employee, false)
        .await?
        .decide(operation, employee, person)
}
