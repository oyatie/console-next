// SPDX-License-Identifier: LicenseRef-Proprietary
//! 완료 for period unlocks: those the caller approved, newest first, while the
//! caller still holds the period-lock grant the open queue requires.
use super::period_locks::authorize_period_lock_manage;
use console_action_inbox_application::ActionInboxLink;
use console_action_inbox_application::done::DoneItem;
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use console_platform_db::with_org_conn;
use time::OffsetDateTime;
use uuid::Uuid;

pub(crate) async fn done(
    pool: &sqlx::PgPool,
    principal: &Principal,
    before: Option<(OffsetDateTime, String)>,
    limit: i64,
) -> Result<Vec<DoneItem>, KernelError> {
    if authorize_period_lock_manage(principal).is_err() {
        return Ok(Vec::new());
    }
    let (org, me) = (principal.org_id, *principal.user_id.as_uuid());
    let (at, id) = before.map_or((None, None), |(at, id)| (Some(at), Some(id)));
    let rows: Vec<(Uuid, Uuid, String, OffsetDateTime, Option<String>)> =
        with_org_conn::<_, _, console_platform_db::DbError>(pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query_as(
                    "SELECT r.id, r.lock_id, r.outcome, r.decided_at, \
                     (SELECT u.display_name FROM person_accounts_current u WHERE u.org_id = r.org_id AND u.id = r.requested_by) \
                     FROM period_unlock_requests r WHERE r.org_id = $1 AND r.decided_by = $2 AND r.outcome = 'APPROVED' \
                     AND ($3::timestamptz IS NULL OR r.decided_at < $3 OR (r.decided_at = $3 \
                       AND ('period_unlock:' || r.id::text) COLLATE \"C\" < $4)) \
                     ORDER BY r.decided_at DESC, ('period_unlock:' || r.id::text) COLLATE \"C\" DESC LIMIT $5",
                )
                .bind(org.as_uuid())
                .bind(me)
                .bind(at)
                .bind(id)
                .bind(limit)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await
        .map_err(|e| {
            tracing::error!(error = ?e, "unlock done source failed");
            KernelError::internal("failed to load finished work")
        })?;
    Ok(rows
        .into_iter()
        .map(|(id, lock_id, outcome, decided_at, requester)| DoneItem {
            id: format!("period_unlock:{id}"),
            kind: "period_unlock".into(),
            title: requester.unwrap_or_default(),
            outcome,
            completed_at: decided_at,
            links: vec![ActionInboxLink {
                kind: "period_lock".into(),
                id: lock_id.to_string(),
                label: None,
            }],
        })
        .collect())
}
