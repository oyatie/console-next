use crate::*;

impl PgOrgChangeStore {
    /// Apply an APPROVED request on or after its 시행일. `holds_apply`: the
    /// caller holds `org_change_apply`. Without it only a tenant on
    /// `approval.policy.org_structure = none` admits the apply (decisions
    /// #26: the change needs no approval, so whoever may propose it may apply
    /// it; the REST floor still requires `org_change_draft`).
    pub async fn effectuate(
        &self,
        actor: UserId,
        id: Uuid,
        holds_apply: bool,
    ) -> Result<OrgChangeDetail, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        let employment_transfer = self.employment_transfer();
        let org_unit_write = self.org_unit_write.clone();
        let outcome = with_audits(&self.pool, org, move |tx| {
            Box::pin(async move {
                if !holds_apply
                    && approval_routes_in_tx(
                        tx.as_mut(),
                        org,
                        SettingKey::ApprovalPolicyOrgStructure,
                    )
                    .await?
                {
                    return Err(
                        KernelError::forbidden("role is not allowed to apply org changes").into(),
                    );
                }
                let request = lock_request(tx, id).await?;
                let audits = effectuate_in_tx(
                    tx,
                    (org, actor, now, today_kst()),
                    id,
                    &request,
                    employment_transfer.as_deref(),
                    org_unit_write.as_deref(),
                )
                .await?;
                let detail = require_detail(tx, id).await?;
                Ok((detail, audits))
            })
        })
        .await;
        self.record_freeze_refusal(org, actor, id, "org_change.effectuate.refused", outcome)
            .await
    }
}

/// Apply an APPROVED request whose 시행일 has come (`today`, KST; the
/// scheduled-change worker passes its own), inside the caller's transaction:
/// every kind replays its ops and is APPLIED. A 폐지 closes the unit on its
/// 시행일 (org-05): the people and sub-units it moves go first, as ops of the
/// same change, and no tick list follows. The people the ops moved are the
/// change's 영향 인원 (org-01, org-04). Shared by
/// [`PgOrgChangeStore::effectuate`], a submit under
/// `approval.policy.org_structure = none` (decisions #26) and the worker.
pub(crate) async fn effectuate_in_tx(
    tx: Tx<'_, '_>,
    (org, actor, now, today): (OrgId, UserId, OffsetDateTime, Date),
    id: Uuid,
    request: &RequestRow,
    employment_transfer: Option<&dyn EmploymentTransferPort>,
    org_unit_write: Option<&dyn OrgUnitWritePort>,
) -> Result<Vec<AuditEvent>, PgOrgChangeError> {
    if request.status != OrgChangeStatus::Approved {
        return Err(KernelError::conflict("only an APPROVED request can be effectuated").into());
    }
    if today < request.effective_date {
        return Err(KernelError::conflict("발효일 이전에는 적용할 수 없습니다.").into());
    }
    let applied = apply_ops(
        tx,
        (org, actor, now),
        id,
        request,
        employment_transfer,
        org_unit_write,
    )
    .await?;
    let mut audits = applied.audits;
    let next = OrgChangeStatus::Applied;
    request.status.can_transition_to(next)?;
    sqlx::query(
        "UPDATE org_change_requests SET status = $2, updated_at = $3, headcount = $4 WHERE id = $1",
    )
    .bind(id)
    .bind(next.as_db())
    .bind(now)
    .bind(applied.people)
    .execute(tx.as_mut())
    .await?;
    insert_event(
        tx,
        org,
        id,
        actor,
        "effectuate",
        Some(OrgChangeStatus::Approved),
        Some(next),
        Some(&format!(
            "ops={} people={}",
            request.proposal.len(),
            applied.people
        )),
        now,
    )
    .await?;
    audits.push(audit(
        org,
        actor,
        "org_change.effectuate",
        "org_change_request",
        id.to_string(),
        now,
    )?);
    Ok(audits)
}
