//! `GET /change-requests`: HR sees the org's requests (optionally only those
//! named to it, or open to the role); everyone else sees only the requests it
//! filed ("Waiting") or is named on (`assignee=me`: its requests for
//! explanation). A correction carries the values it asks for, so HR's page is
//! a list read of the people its corrections are about.

use console_hr_domain::requests::ChangeRequestKind;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::postgres::PgRow;
use sqlx::{Postgres, QueryBuilder, Row};
use uuid::Uuid;

use super::{ChangeRequestListQuery, ChangeRequestPage, ChangeRequestResponse};
use crate::authz::{hr_reach, push_subject_in_reach};
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::metrics::record_hr_read;
use crate::paging::{DEFAULT_LIMIT, MAX_LIMIT};
use crate::{HrError, HrService};

/// The `change_requests` columns [`change_request_from_row`] reads, as a
/// literal so statements can `concat!` it.
#[macro_export]
macro_rules! change_request_columns {
    () => {
        "id, kind, subject_type, subject_id, payload, reason_code, note, requested_by, \
         assignee_role, assignee_user_id, status, decided_by, decision_reason_code, \
         decision_note, created_at, decided_at"
    };
}

pub fn change_request_from_row(row: &PgRow) -> Result<ChangeRequestResponse, HrError> {
    let kind: String = row.try_get("kind")?;
    Ok(ChangeRequestResponse {
        id: row.try_get("id")?,
        review_required: ChangeRequestKind::parse(&kind)
            .map(ChangeRequestKind::review_required)
            .unwrap_or(false),
        kind,
        subject_type: row.try_get("subject_type")?,
        subject_id: row.try_get("subject_id")?,
        subject_name: row.try_get("subject_name").ok().flatten(),
        subject_number: row.try_get("subject_number").ok().flatten(),
        payload: row.try_get("payload")?,
        reason_code: row.try_get("reason_code")?,
        note: row.try_get("note")?,
        requested_by: row.try_get("requested_by")?,
        assignee_role: row.try_get("assignee_role")?,
        assignee_user_id: row.try_get("assignee_user_id")?,
        status: row.try_get("status")?,
        decided_by: row.try_get("decided_by")?,
        decision_reason_code: row.try_get("decision_reason_code")?,
        decision_note: row.try_get("decision_note")?,
        created_at: row.try_get("created_at")?,
        decided_at: row.try_get("decided_at")?,
    })
}

impl HrService {
    pub async fn list_change_requests(
        &self,
        principal: Principal,
        query: ChangeRequestListQuery,
    ) -> Result<ChangeRequestPage, HrError> {
        // No reader preflight: outside HR the rows are the caller's own (filed
        // or named to it), so a named handler without directory access still
        // finds the request for explanation it must answer.
        record_hr_read("change_requests");
        // AX-5: HR sees the requests about the people inside its grant set.
        let reach = hr_reach(&principal, Feature::EmployeeDirectoryManage).ok();
        let hr = reach.is_some();
        let assignee = match query.assignee.as_deref().map(str::trim) {
            None | Some("") => None,
            Some("me") => Some("me".to_owned()),
            Some("role") if hr => Some("role".to_owned()),
            Some("role") => {
                return Err(HrError::from_kernel(
                    console_kernel_core::KernelError::forbidden(
                        "only HR lists the requests open to the role",
                    ),
                ));
            }
            Some(_) => return Err(HrError::validation("assignee must be me or role")),
        };
        let filed_only = match query.requester.as_deref().map(str::trim) {
            None | Some("") => false,
            Some("me") => true,
            Some(_) => return Err(HrError::validation("requester must be me")),
        };
        let status = match query.status.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(value @ ("OPEN" | "APPLIED" | "DECLINED" | "WITHDRAWN")) => Some(value.to_owned()),
            Some(_) => {
                return Err(HrError::validation(
                    "status must be OPEN, APPLIED, DECLINED or WITHDRAWN",
                ));
            }
        };
        let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let offset = query.offset.unwrap_or(0).max(0);
        let me = *principal.user_id.as_uuid();

        let org = principal.org_id;
        let (items, total) = with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let push_filters = |builder: &mut QueryBuilder<Postgres>| {
                    builder.push(" WHERE TRUE AND (r.requested_by = ");
                    builder.push_bind(me);
                    builder.push(" OR r.assignee_user_id = ");
                    builder.push_bind(me);
                    if let Some(reach) = &reach {
                        builder.push(" OR ");
                        push_subject_in_reach(builder, reach, "r.");
                    }
                    builder.push(")");
                    if filed_only {
                        builder.push(" AND r.requested_by = ");
                        builder.push_bind(me);
                    }
                    match assignee.as_deref() {
                        Some("me") => {
                            builder.push(" AND r.assignee_user_id = ");
                            builder.push_bind(me);
                        }
                        Some(_) => {
                            builder.push(" AND r.assignee_user_id IS NULL");
                        }
                        None => {}
                    }
                    if let Some(status) = status.clone() {
                        builder.push(" AND r.status = ");
                        builder.push_bind(status);
                    }
                };
                let mut count = QueryBuilder::<Postgres>::new("SELECT count(*) FROM change_requests r");
                push_filters(&mut count);
                let total: i64 = count.build_query_scalar().fetch_one(tx.as_mut()).await?;
                let mut rows = QueryBuilder::<Postgres>::new(
                    "SELECT r.id, r.kind, r.subject_type, r.subject_id, r.payload, r.reason_code, \
                     r.note, r.requested_by, r.assignee_role, r.assignee_user_id, r.status, \
                     r.decided_by, r.decision_reason_code, r.decision_note, r.created_at, r.decided_at, \
                     CASE WHEN r.subject_type = 'EMPLOYEE' THEN \
                       COALESCE(console_employee_facts(e.org_id, e.id)->>'legal_name', e.name) \
                     WHEN r.subject_type = 'USER_ACCOUNT' THEN u.display_name \
                     WHEN r.subject_type = 'BRANCH' THEN b.name END AS subject_name, \
                     CASE WHEN r.subject_type = 'EMPLOYEE' THEN e.employee_number END AS subject_number \
                     FROM change_requests r \
                     LEFT JOIN person_employees_current e \
                       ON r.subject_type = 'EMPLOYEE' AND e.org_id = r.org_id AND e.id = r.subject_id \
                     LEFT JOIN person_accounts_current u \
                       ON r.subject_type = 'USER_ACCOUNT' AND u.org_id = r.org_id AND u.id = r.subject_id \
                     LEFT JOIN branches b \
                       ON r.subject_type = 'BRANCH' AND b.org_id = r.org_id AND b.id = r.subject_id",
                );
                push_filters(&mut rows);
                rows.push(" ORDER BY r.created_at DESC, r.id DESC LIMIT ");
                rows.push_bind(limit);
                rows.push(" OFFSET ");
                rows.push_bind(offset);
                let items = rows
                    .build()
                    .fetch_all(tx.as_mut())
                    .await?
                    .iter()
                    .map(change_request_from_row)
                    .collect::<Result<Vec<_>, _>>()?;
                let mut corrected: Vec<Uuid> = items
                    .iter()
                    .filter(|r| r.kind == "PROFILE_CORRECTION" && r.subject_type == "EMPLOYEE")
                    .map(|r| r.subject_id)
                    .collect();
                corrected.sort_unstable();
                corrected.dedup();
                if !hr || corrected.is_empty() {
                    return Ok(((items, total), Vec::new()));
                }
                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::List,
                    &corrected,
                    me,
                    json!({ "view": "change_requests" }),
                )?;
                Ok(((items, total), vec![event]))
            })
        })
        .await?;
        Ok(ChangeRequestPage {
            items,
            total,
            limit,
            offset,
        })
    }
}
