use crate::*;

impl PgOrgChangeStore {
    pub async fn complete_settlement_item(
        &self,
        actor: UserId,
        id: Uuid,
        item_id: Uuid,
        memo: Option<String>,
    ) -> Result<OrgChangeDetail, PgOrgChangeError> {
        if let Some(memo) = &memo {
            bounded_text(memo, "memo", 2000)?;
        }
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        with_audits(&self.pool, org, |tx| {
            Box::pin(async move {
                let request = lock_request(tx, id).await?;
                if request.status != OrgChangeStatus::Settling {
                    return Err(KernelError::conflict(
                        "settlement items complete only while the request is SETTLING",
                    )
                    .into());
                }
                let item = sqlx::query(
                    "SELECT item_key, done FROM org_change_settlement_items \
                     WHERE id = $1 AND request_id = $2 FOR UPDATE",
                )
                .bind(item_id)
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("settlement item was not found"))?;
                if item.try_get::<bool, _>("done")? {
                    return Err(KernelError::conflict("settlement item is already complete").into());
                }
                let item_key: String = item.try_get("item_key")?;
                sqlx::query(
                    "UPDATE org_change_settlement_items SET done = true, done_by = $2, \
                     done_at = $3, memo = $4 WHERE id = $1",
                )
                .bind(item_id)
                .bind(*actor.as_uuid())
                .bind(now)
                .bind(memo.as_deref())
                .execute(tx.as_mut())
                .await?;
                sqlx::query("UPDATE org_change_requests SET updated_at = $2 WHERE id = $1")
                    .bind(id)
                    .bind(now)
                    .execute(tx.as_mut())
                    .await?;
                insert_event(
                    tx,
                    org,
                    id,
                    actor,
                    "settlement.complete",
                    None,
                    None,
                    Some(&item_key),
                    now,
                )
                .await?;
                let detail = require_detail(tx, id).await?;
                Ok((
                    detail,
                    vec![audit(
                        org,
                        actor,
                        "org_change.settlement.complete",
                        "org_change_settlement_item",
                        item_id.to_string(),
                        now,
                    )?],
                ))
            })
        })
        .await
    }
}
