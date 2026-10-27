//! The assignee's 내 차례: OPEN change requests the caller can decide or answer.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use sqlx::{Postgres, QueryBuilder, Row};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::authz::{hr_reach, push_subject_in_reach};
use crate::{HrError, HrService};

/// The inbox id prefix; the keyset compares `'hr_request:' || id`.
pub const INBOX_ID_PREFIX: &str = "hr_request:";

#[derive(Debug)]
pub struct ChangeRequestInboxItem {
    pub id: Uuid,
    pub kind: String,
    pub reason_code: String,
    pub subject_type: String,
    pub subject_id: Uuid,
    pub title: String,
    pub created_at: OffsetDateTime,
}

pub struct ChangeRequestInboxPage {
    pub items: Vec<ChangeRequestInboxItem>,
    pub total: i64,
    pub has_more: bool,
}

impl HrService {
    /// Undated inbox-id keyset page: what the caller can act
    /// on. HR sees requests open to the role or named to it; anyone else only
    /// the answer kinds named to it (a 소명 요청, a policy question). The
    /// caller's own requests and those named to someone else are left out.
    pub async fn change_request_inbox_page(
        &self,
        principal: &Principal,
        as_of: OffsetDateTime,
        after: Option<(Option<OffsetDateTime>, OffsetDateTime, String)>,
        limit: i64,
    ) -> Result<ChangeRequestInboxPage, HrError> {
        // AX-5: HR acts on the open requests about people inside its grant set.
        let reach = hr_reach(principal, Feature::EmployeeDirectoryManage).ok();
        let limit = limit.clamp(1, 200);
        let me = *principal.user_id.as_uuid();
        let push_where = move |q: &mut QueryBuilder<Postgres>| {
            q.push(" FROM change_requests c WHERE c.status = 'OPEN' AND c.requested_by <> ");
            q.push_bind(me);
            q.push(" AND (c.assignee_user_id = ");
            q.push_bind(me);
            match &reach {
                Some(reach) => {
                    q.push(" OR (c.assignee_user_id IS NULL AND ");
                    push_subject_in_reach(q, reach, "c.");
                    q.push("))");
                }
                None => {
                    q.push(") AND c.kind IN ('ACCESS_EXPLANATION', 'POLICY_QUESTION')");
                }
            }
            q.push(" AND c.created_at <= ");
            q.push_bind(as_of);
        };
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let mut count = QueryBuilder::<Postgres>::new("SELECT count(*)");
                push_where(&mut count);
                let total: i64 = count.build_query_scalar().fetch_one(tx.as_mut()).await?;
                let mut q = QueryBuilder::<Postgres>::new(
                    "SELECT c.id, c.kind, c.reason_code, c.subject_type, c.subject_id, c.created_at, \
                     COALESCE((SELECT e.name FROM person_employees_current e WHERE e.org_id = c.org_id \
                        AND c.subject_type = 'EMPLOYEE' AND e.id = c.subject_id), \
                       (SELECT u.display_name FROM person_accounts_current u WHERE u.org_id = c.org_id \
                        AND u.id = CASE WHEN c.subject_type = 'USER_ACCOUNT' THEN c.subject_id \
                            ELSE c.requested_by END)) AS title",
                );
                push_where(&mut q);
                console_platform_db::inbox::push_page(
                    &mut q,
                    "NULL::timestamptz",
                    "c.created_at",
                    "('hr_request:' || c.id::text)",
                    after,
                    limit,
                );
                let rows = q.build().fetch_all(tx.as_mut()).await?;
                let has_more = i64::try_from(rows.len()).unwrap_or(0) > limit;
                let items = rows
                    .iter()
                    .take(usize::try_from(limit).unwrap_or(rows.len()))
                    .map(|row| {
                        Ok(ChangeRequestInboxItem {
                            id: row.try_get("id")?,
                            kind: row.try_get("kind")?,
                            reason_code: row.try_get("reason_code")?,
                            subject_type: row.try_get("subject_type")?,
                            subject_id: row.try_get("subject_id")?,
                            title: row.try_get("title")?,
                            created_at: row.try_get("created_at")?,
                        })
                    })
                    .collect::<Result<Vec<_>, HrError>>()?;
                Ok(ChangeRequestInboxPage {
                    items,
                    total,
                    has_more,
                })
            })
        })
        .await
    }
}
