//! `GET /change-requests`: HR sees the org's requests (optionally only those
//! named to it, or open to the role); everyone else sees only the requests it
//! filed (기다리는 중) or is named on (`assignee=me`: its 소명 요청).

use console_hr_domain::requests::ChangeRequestKind;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use sqlx::postgres::PgRow;
use sqlx::{Postgres, QueryBuilder, Row};

use super::{ChangeRequestListQuery, ChangeRequestPage, ChangeRequestResponse};
use crate::authz::{hr_reach, push_subject_in_reach};
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
        // or named to it), so a named 취급자 without directory access still
        // finds the 소명 요청 it must answer.
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

        let push_filters = move |builder: &mut QueryBuilder<Postgres>| {
            builder.push(" FROM change_requests WHERE TRUE");
            builder.push(" AND (requested_by = ");
            builder.push_bind(me);
            builder.push(" OR assignee_user_id = ");
            builder.push_bind(me);
            if let Some(reach) = &reach {
                builder.push(" OR ");
                push_subject_in_reach(builder, reach, "");
            }
            builder.push(")");
            if filed_only {
                builder.push(" AND requested_by = ");
                builder.push_bind(me);
            }
            match assignee.as_deref() {
                Some("me") => {
                    builder.push(" AND assignee_user_id = ");
                    builder.push_bind(me);
                }
                Some(_) => {
                    builder.push(" AND assignee_user_id IS NULL");
                }
                None => {}
            }
            if let Some(status) = status.clone() {
                builder.push(" AND status = ");
                builder.push_bind(status);
            }
        };
        let (items, total) =
            with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
                Box::pin(async move {
                    let mut count = QueryBuilder::<Postgres>::new("SELECT count(*)");
                    push_filters(&mut count);
                    let total: i64 = count.build_query_scalar().fetch_one(tx.as_mut()).await?;
                    let mut rows = QueryBuilder::<Postgres>::new("SELECT ");
                    rows.push(change_request_columns!());
                    push_filters(&mut rows);
                    rows.push(" ORDER BY created_at DESC, id DESC LIMIT ");
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
                    Ok((items, total))
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
