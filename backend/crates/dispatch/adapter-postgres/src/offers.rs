// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{PgDispatchError, PgDispatchStore};
use console_dispatch_application::MyDispatchOffer;
use console_kernel_core::{BranchId, KernelError, P1DispatchId, UserId, WorkOrderId};
use console_platform_db::with_org_conn;
use console_platform_request_context::current_org;
use sqlx::Row;
use time::OffsetDateTime;

impl PgDispatchStore {
    /// List the caller's pending P1 offers: BROADCASTING dispatches that
    /// fanned out to the caller as a TECHNICIAN, still inside the accept
    /// window, with no response from the caller yet. Read-only and
    /// person-scoped — `user` is bound from the authenticated principal, so a
    /// caller can only ever see offers addressed to them (deny-by-omission).
    pub async fn list_my_pending_offers(
        &self,
        user: UserId,
        now: OffsetDateTime,
    ) -> Result<Vec<MyDispatchOffer>, PgDispatchError> {
        let org = current_org().map_err(KernelError::from)?;
        let user_uuid = *user.as_uuid();
        let rows = with_org_conn::<_, _, PgDispatchError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(sqlx::query(
                    r#"
                    SELECT d.id AS dispatch_id, d.work_order_id, d.branch_id,
                           w.request_no, s.name AS site_name, w.symptom, d.accept_window_started_at, d.accept_window_ends_at
                    FROM p1_dispatches d
                    JOIN p1_dispatch_targets t
                      ON t.dispatch_id = d.id
                     AND t.user_id = $1
                     AND t.target_role = 'TECHNICIAN'
                    JOIN work_orders w ON w.id = d.work_order_id AND w.org_id = d.org_id
                    JOIN registry_sites s ON s.id = w.site_id AND s.org_id = w.org_id
                    WHERE d.status = 'BROADCASTING'
                      AND d.accept_window_ends_at > $2
                      AND NOT EXISTS (
                          SELECT 1 FROM p1_dispatch_responses r
                          WHERE r.dispatch_id = d.id AND r.user_id = $1
                      )
                    ORDER BY d.accept_window_ends_at ASC
                    "#,
                )
                .bind(user_uuid)
                .bind(now)
                .fetch_all(tx.as_mut())
                .await?)
            })
        })
        .await?;

        rows.iter()
            .map(|row| {
                Ok(MyDispatchOffer {
                    dispatch_id: P1DispatchId::from_uuid(row.try_get("dispatch_id")?),
                    work_order_id: WorkOrderId::from_uuid(row.try_get("work_order_id")?),
                    branch_id: BranchId::from_uuid(row.try_get("branch_id")?),
                    request_no: row.try_get("request_no")?,
                    site_name: row.try_get("site_name")?,
                    symptom: row.try_get("symptom")?,
                    accept_window_started_at: row.try_get("accept_window_started_at")?,
                    accept_window_ends_at: row.try_get("accept_window_ends_at")?,
                })
            })
            .collect()
    }
}
