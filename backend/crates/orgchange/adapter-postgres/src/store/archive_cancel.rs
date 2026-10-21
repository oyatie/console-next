use crate::*;

impl PgOrgChangeStore {
    pub async fn archive(
        &self,
        actor: UserId,
        id: Uuid,
    ) -> Result<OrgChangeDetail, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        let employment_transfer = self.employment_transfer();
        let org_unit_write = self.org_unit_write.clone();
        let outcome = with_audits(&self.pool, org, move |tx| {
            Box::pin(async move {
                let request = lock_request(tx, id).await?;
                if request.status != OrgChangeStatus::Settling {
                    return Err(
                        KernelError::conflict("only a SETTLING request can be archived").into(),
                    );
                }
                request
                    .status
                    .can_transition_to(OrgChangeStatus::Archived)?;
                let unsettled: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM org_change_settlement_items \
                     WHERE request_id = $1 AND done = false",
                )
                .bind(id)
                .fetch_one(tx.as_mut())
                .await?;
                if unsettled > 0 {
                    return Err(KernelError::conflict(
                        "unsettled items remain; complete every settlement item first",
                    )
                    .into());
                }
                // A legacy SETTLING 폐지 (stored before org-05 applied 폐지 on
                // its 시행일): the deferred ops run now, inside this one tx; the
                // referential guards re-verify (settlement must have actually
                // cleared the dependents, or this rolls back with a conflict).
                let mut audits = apply_ops(
                    tx,
                    (org, actor, now),
                    id,
                    &request,
                    employment_transfer.as_deref(),
                    org_unit_write.as_deref(),
                )
                .await?
                .audits;
                sqlx::query(
                    "UPDATE org_change_requests SET status = 'ARCHIVED', updated_at = $2 \
                     WHERE id = $1",
                )
                .bind(id)
                .bind(now)
                .execute(tx.as_mut())
                .await?;
                insert_event(
                    tx,
                    org,
                    id,
                    actor,
                    "archive",
                    Some(OrgChangeStatus::Settling),
                    Some(OrgChangeStatus::Archived),
                    None,
                    now,
                )
                .await?;
                audits.push(audit(
                    org,
                    actor,
                    "org_change.archive",
                    "org_change_request",
                    id.to_string(),
                    now,
                )?);
                let detail = require_detail(tx, id).await?;
                Ok((detail, audits))
            })
        })
        .await;
        self.record_freeze_refusal(org, actor, id, "org_change.archive.refused", outcome)
            .await
    }

    pub async fn cancel(
        &self,
        actor: UserId,
        id: Uuid,
        reason: String,
        holds_apply: bool,
    ) -> Result<OrgChangeDetail, PgOrgChangeError> {
        bounded_text(&reason, "reason", 4000)?;
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        with_audits(&self.pool, org, |tx| {
            Box::pin(async move {
                let request = lock_request(tx, id).await?;
                request
                    .status
                    .can_transition_to(OrgChangeStatus::Cancelled)?;
                // 예약 취소 (org-02): a scheduled change is cancelled before its date.
                may_touch_scheduled(tx, org, &request, holds_apply).await?;
                sqlx::query(
                    "UPDATE org_change_requests SET status = 'CANCELLED', updated_at = $2 \
                     WHERE id = $1",
                )
                .bind(id)
                .bind(now)
                .execute(tx.as_mut())
                .await?;
                insert_event(
                    tx,
                    org,
                    id,
                    actor,
                    "cancel",
                    Some(request.status),
                    Some(OrgChangeStatus::Cancelled),
                    Some(&reason),
                    now,
                )
                .await?;
                let detail = require_detail(tx, id).await?;
                Ok((
                    detail,
                    vec![audit(
                        org,
                        actor,
                        "org_change.cancel",
                        "org_change_request",
                        id.to_string(),
                        now,
                    )?],
                ))
            })
        })
        .await
    }
}
