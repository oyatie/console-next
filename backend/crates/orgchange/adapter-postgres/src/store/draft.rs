use crate::*;

impl PgOrgChangeStore {
    pub async fn update_draft(
        &self,
        actor: UserId,
        id: Uuid,
        patch: DraftPatch,
        holds_apply: bool,
    ) -> Result<OrgChangeDetail, PgOrgChangeError> {
        if let Some(reason) = &patch.reason {
            bounded_text(reason, "reason", 4000)?;
        }
        if let Some(proposal) = &patch.proposal {
            validate_proposal(proposal)?;
        }
        if let Some(date) = patch.effective_date
            && date < today_kst()
        {
            return Err(
                KernelError::validation("effectiveDate must be today or later (KST)").into(),
            );
        }
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        let (people, units) = (self.employment_transfer(), self.org_unit_write.clone());

        with_audits(&self.pool, org, |tx| {
            Box::pin(async move {
                let request = lock_request(tx, id).await?;
                // 예약 수정 (org-02): a scheduled change moves its date or reason.
                if request.status == OrgChangeStatus::Approved {
                    may_touch_scheduled(tx, org, &request, holds_apply).await?;
                    let ports = (people.as_deref(), units.as_deref());
                    let audits = reschedule_in_tx(tx, (org, actor, now), id, &patch, ports).await?;
                    return Ok((require_detail(tx, id).await?, audits));
                }
                if !request.status.is_draft_editable() {
                    return Err(KernelError::conflict(
                        "only a DRAFT or PRECHECKED request can be edited",
                    )
                    .into());
                }
                if let Some(proposal) = &patch.proposal {
                    require_org_unit_refs_visible(tx, org, proposal).await?;
                }
                let proposal_json = match &patch.proposal {
                    Some(proposal) => Some(
                        serde_json::to_value(proposal)
                            .map_err(|_| KernelError::internal("proposal serialization failed"))?,
                    ),
                    None => None,
                };
                sqlx::query(
                    "UPDATE org_change_requests SET \
                     kind = COALESCE($2, kind), \
                     effective_date = COALESCE($3, effective_date), \
                     reason = COALESCE($4, reason), \
                     proposal = COALESCE($5, proposal), \
                     status = 'DRAFT', updated_at = $6 \
                     WHERE id = $1",
                )
                .bind(id)
                .bind(patch.kind.map(OrgChangeKind::as_db))
                .bind(patch.effective_date)
                .bind(patch.reason.as_deref())
                .bind(proposal_json)
                .bind(now)
                .execute(tx.as_mut())
                .await?;
                insert_event(
                    tx,
                    org,
                    id,
                    actor,
                    "draft.update",
                    Some(request.status),
                    Some(OrgChangeStatus::Draft),
                    None,
                    now,
                )
                .await?;
                let detail = require_detail(tx, id).await?;
                Ok((
                    detail,
                    vec![audit(
                        org,
                        actor,
                        "org_change.draft.update",
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
