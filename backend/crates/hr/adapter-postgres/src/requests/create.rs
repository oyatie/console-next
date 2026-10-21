//! `POST /change-requests`: a reader files a request to HR (or, for the answer
//! kinds, to a named person) about a subject it can see. An employee or branch
//! outside the caller's scope reads as 404.

use console_hr_domain::requests::{ChangeRequestKind, validate_new_request};
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::read::change_request_from_row;
use super::{
    ASSIGNEE_ROLE_HR, ChangeRequestResponse, CreateChangeRequest, note, reason_code, refusal,
};
use crate::authz::{
    Tier, authorize_hr_org_wide, authorize_hr_person_in, authorize_hr_scoped_write, hr_reach_in,
};
use crate::corrections::{normalize_value, route_or_refuse};
use crate::{HrError, HrService, change_request_columns};

fn not_found(subject_type: &str) -> HrError {
    HrError::from_kernel(KernelError::not_found(format!(
        "{subject_type} subject was not found in this organization"
    )))
}

/// The subject exists in this org and, when it lives in a branch, that branch
/// is in the caller's scope.
async fn authorize_subject(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    org: Uuid,
    subject_type: &str,
    subject_id: Uuid,
) -> Result<(), HrError> {
    let branch: Option<Option<Uuid>> = match subject_type {
        // AX-5: a person inside the requester's grant set (outside it, or no
        // such person, is one `out_of_scope`).
        "EMPLOYEE" => {
            return authorize_hr_person_in(
                tx,
                principal,
                Feature::EmployeeDirectoryRead,
                subject_id,
                Tier::Branch,
            )
            .await;
        }
        "BRANCH" => sqlx::query_scalar("SELECT id FROM branches WHERE org_id = $1 AND id = $2")
            .bind(org)
            .bind(subject_id)
            .fetch_optional(tx.as_mut())
            .await?
            .map(Some),
        "USER_ACCOUNT" => {
            sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE org_id = $1 AND id = $2")
                .bind(org)
                .bind(subject_id)
                .fetch_optional(tx.as_mut())
                .await?
                .map(|_| None)
        }
        "ORGANIZATION" => (subject_id == org).then_some(None),
        _ => None,
    };
    let Some(branch) = branch else {
        return Err(not_found(subject_type));
    };
    if subject_type == "BRANCH" {
        authorize_hr_scoped_write(principal, Feature::EmployeeDirectoryRead, branch)
            .map_err(|_| not_found(subject_type))?;
    }
    Ok(())
}

/// PROFILE_CORRECTION carries `{ changes: { field: value, .. } }` with at
/// least one correctable field; other kinds carry any object (or none).
fn payload(kind: ChangeRequestKind, raw: Option<Value>) -> Result<Value, HrError> {
    let payload = raw.unwrap_or_else(|| json!({}));
    if !payload.is_object() {
        return Err(HrError::validation("payload must be an object"));
    }
    if kind == ChangeRequestKind::EmployeeVoid {
        // Fail closed: a void is filed with its checks and attestation by
        // POST /employees/{id}/void, never by hand.
        return Err(HrError::validation(
            "an EMPLOYEE_VOID request is filed by POST /api/v1/employees/{id}/void",
        ));
    }
    if kind == ChangeRequestKind::ProfileCorrection {
        let changes = payload
            .get("changes")
            .and_then(Value::as_object)
            .filter(|changes| !changes.is_empty())
            .ok_or_else(|| HrError::validation("payload.changes must name at least one field"))?;
        // A request is only filed for a field that can be applied.
        for (field, value) in changes {
            route_or_refuse(field)?;
            normalize_value(field, value)?;
        }
    }
    Ok(payload)
}

/// One request row to file inside the caller's transaction.
pub struct NewChangeRequest<'a> {
    pub org: Uuid,
    pub kind: ChangeRequestKind,
    pub subject_type: &'a str,
    pub subject_id: Uuid,
    pub payload: &'a Value,
    pub reason_code: &'a str,
    pub note: Option<&'a str>,
    pub requested_by: Uuid,
    pub assignee_user_id: Option<Uuid>,
}

/// Files a request to HR inside the caller's transaction (BW-17 create, and
/// BW-18 when a correction or a merge needs a second person).
pub async fn insert_change_request_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    new: NewChangeRequest<'_>,
) -> Result<ChangeRequestResponse, HrError> {
    if new.kind == ChangeRequestKind::ProfileCorrection {
        let changes = new
            .payload
            .get("changes")
            .and_then(Value::as_object)
            .ok_or_else(|| HrError::validation("payload.changes must name at least one field"))?;
        let fields = changes
            .iter()
            .map(|(field, value)| Ok((field.clone(), normalize_value(field, value)?)))
            .collect::<Result<Vec<_>, HrError>>()?;
        crate::corrections::catalog::check_in_tx(tx, new.org, &fields).await?;
    }
    let row = sqlx::query(concat!(
        "INSERT INTO change_requests (org_id, kind, subject_type, subject_id, payload, \
         reason_code, note, requested_by, assignee_role, assignee_user_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ",
        change_request_columns!()
    ))
    .bind(new.org)
    .bind(new.kind.as_str())
    .bind(new.subject_type)
    .bind(new.subject_id)
    .bind(new.payload)
    .bind(new.reason_code)
    .bind(new.note)
    .bind(new.requested_by)
    .bind(ASSIGNEE_ROLE_HR)
    .bind(new.assignee_user_id)
    .fetch_one(tx.as_mut())
    .await?;
    change_request_from_row(&row)
}

impl HrService {
    pub async fn create_change_request(
        &self,
        principal: Principal,
        body: CreateChangeRequest,
    ) -> Result<ChangeRequestResponse, HrError> {
        let kind = ChangeRequestKind::parse(body.kind.trim())?;
        // A 소명 요청 comes out of the 접속기록 review: only an org-wide
        // access-log reader asks a 취급자 to explain an access (no directory
        // access needed); every other kind is filed by a directory reader.
        if kind == ChangeRequestKind::AccessExplanation {
            authorize_hr_org_wide(&principal, Feature::AuditLogRead)?;
        } else {
            hr_reach_in(&principal, Feature::EmployeeDirectoryRead, Tier::Branch)?;
        }
        let subject_type = body.subject_type.trim().to_owned();
        let note = note(body.note.as_deref())?;
        validate_new_request(
            kind,
            &subject_type,
            body.subject_id,
            body.assignee_user_id,
            note.as_deref(),
        )?;
        let payload = payload(kind, body.payload)?;
        let reason = reason_code(&body.reason_code, "reason_code")?;
        let me = *principal.user_id.as_uuid();
        if body.assignee_user_id == Some(me) {
            return Err(refusal(
                StatusCode::UNPROCESSABLE_ENTITY,
                "change_request_self_decision",
                "a request cannot be assigned to its requester",
            ));
        }
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                authorize_subject(tx, &principal, org_uuid, &subject_type, body.subject_id).await?;
                if let Some(assignee) = body.assignee_user_id {
                    let exists: Option<Uuid> =
                        sqlx::query_scalar("SELECT id FROM users WHERE org_id = $1 AND id = $2")
                            .bind(org_uuid)
                            .bind(assignee)
                            .fetch_optional(tx.as_mut())
                            .await?;
                    if exists.is_none() {
                        return Err(HrError::validation(
                            "assignee_user_id is not a user of this organization",
                        ));
                    }
                }
                let created = insert_change_request_in_tx(
                    tx,
                    NewChangeRequest {
                        org: org_uuid,
                        kind,
                        subject_type: &subject_type,
                        subject_id: body.subject_id,
                        payload: &payload,
                        reason_code: &reason,
                        note: note.as_deref(),
                        requested_by: me,
                        assignee_user_id: body.assignee_user_id,
                    },
                )
                .await?;
                // No field values in the audit: the payload stays in its row.
                let fields: Vec<&String> = payload
                    .get("changes")
                    .and_then(Value::as_object)
                    .map(|changes| changes.keys().collect())
                    .unwrap_or_default();
                let event = AuditEvent::new(
                    Some(principal.user_id),
                    AuditAction::new("change_request.create").map_err(HrError::from_kernel)?,
                    "change_request",
                    created.id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({
                        "kind": kind.as_str(),
                        "subject_type": &created.subject_type,
                        "subject_id": created.subject_id,
                        "fields": fields,
                        "reason_code": &created.reason_code,
                        "assignee_user_id": created.assignee_user_id,
                    })),
                );
                Ok((created, vec![event]))
            })
        })
        .await
    }
}
