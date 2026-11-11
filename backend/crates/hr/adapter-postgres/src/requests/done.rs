//! 완료 for change requests: those the caller decided (APPLIED or DECLINED),
//! newest first. The open queue's own reach applies today, so a decider who
//! has since lost the grant no longer sees the names.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use sqlx::{Postgres, QueryBuilder, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::{hr_reach, push_subject_in_reach};
use crate::{HrError, HrService};

#[derive(Debug)]
pub struct ChangeRequestDone {
    pub id: Uuid,
    pub kind: String,
    pub status: String,
    pub subject_type: String,
    pub subject_id: Uuid,
    pub title: String,
    pub decided_at: OffsetDateTime,
}

impl HrService {
    /// At most `limit` requests the caller decided, older than `before`
    /// (`decided_at`, namespaced id), newest first.
    pub async fn change_request_done_page(
        &self,
        principal: &Principal,
        before: Option<(OffsetDateTime, String)>,
        limit: i64,
    ) -> Result<Vec<ChangeRequestDone>, HrError> {
        let reach = hr_reach(principal, Feature::EmployeeDirectoryManage).ok();
        let me = *principal.user_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let mut q = QueryBuilder::<Postgres>::new(
                    "SELECT c.id, c.kind, c.status, c.subject_type, c.subject_id, c.decided_at, \
                     COALESCE((SELECT e.name FROM person_employees_current e WHERE e.org_id = c.org_id \
                        AND c.subject_type = 'EMPLOYEE' AND e.id = c.subject_id), \
                       (SELECT u.display_name FROM person_accounts_current u WHERE u.org_id = c.org_id \
                        AND u.id = CASE WHEN c.subject_type = 'USER_ACCOUNT' THEN c.subject_id \
                            ELSE c.requested_by END)) AS title \
                     FROM change_requests c WHERE c.status IN ('APPLIED', 'DECLINED') AND c.decided_by = ",
                );
                q.push_bind(me).push(" AND (c.assignee_user_id = ").push_bind(me);
                match &reach {
                    Some(reach) => {
                        q.push(" OR (c.assignee_user_id IS NULL AND ");
                        push_subject_in_reach(&mut q, reach, "c.");
                        q.push("))");
                    }
                    None => {
                        q.push(") AND c.kind IN ('ACCESS_EXPLANATION', 'POLICY_QUESTION')");
                    }
                }
                if let Some((at, id)) = before {
                    q.push(" AND (c.decided_at < ").push_bind(at);
                    q.push(" OR (c.decided_at = ").push_bind(at);
                    q.push(" AND ('hr_request:' || c.id::text) COLLATE \"C\" < ").push_bind(id).push("))");
                }
                q.push(" ORDER BY c.decided_at DESC, ('hr_request:' || c.id::text) COLLATE \"C\" DESC LIMIT ");
                q.push_bind(limit.clamp(1, 201));
                q.build()
                    .fetch_all(tx.as_mut())
                    .await?
                    .iter()
                    .map(|row| {
                        Ok(ChangeRequestDone {
                            id: row.try_get("id")?,
                            kind: row.try_get("kind")?,
                            status: row.try_get("status")?,
                            subject_type: row.try_get("subject_type")?,
                            subject_id: row.try_get("subject_id")?,
                            title: row.try_get("title")?,
                            decided_at: row.try_get("decided_at")?,
                        })
                    })
                    .collect()
            })
        })
        .await
    }
}
