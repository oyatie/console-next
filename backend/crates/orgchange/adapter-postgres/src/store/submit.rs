use crate::*;

impl PgOrgChangeStore {
    /// Preflight is a READ. It computes the receipt and returns it, and it
    /// persists NOTHING — no `PRECHECKED` status flip, no `org_change_events`
    /// row, no audit row, no column rewrite. `submit` recomputes the same
    /// receipt inside its own transaction and is the only writer, so there is
    /// no stored receipt that can disagree with the state at submit time.
    ///
    /// The request row is still read under a `SELECT ... FOR UPDATE` so the
    /// receipt is computed against a state no concurrent draft edit can shift
    /// mid-scan; the lock is released by the read transaction's commit.
    pub async fn preflight(
        &self,
        _actor: UserId,
        id: Uuid,
    ) -> Result<OrgChangeDetail, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        let employment_transfer = self.employment_transfer();
        let org_unit_write = self.org_unit_write.clone();
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move {
                let request = lock_request(tx, id).await?;
                if !request.status.is_draft_editable() {
                    return Err(KernelError::conflict(
                        "preflight runs only on a DRAFT or PRECHECKED request",
                    )
                    .into());
                }
                let mut report = compute_preflight(
                    tx,
                    org,
                    request.kind,
                    &request.target,
                    &request.proposal,
                    request.effective_date,
                    now,
                )
                .await?;
                let ports = (employment_transfer.as_deref(), org_unit_write.as_deref());
                dry_run_apply(tx, (org, _actor, now), id, &request, ports, &mut report).await?;
                let (site_count, team_count) = proposal_stats(&request.target, &request.proposal);
                let mut detail = require_detail(tx, id).await?;
                // The receipt and the counts derived from it are reported, not
                // stored; the persisted columns keep whatever the last WRITE
                // (create/update_draft/submit) left there.
                detail.summary.headcount = report.headcount;
                detail.summary.site_count = site_count;
                detail.summary.team_count = team_count;
                detail.preflight = Some(report);
                Ok(detail)
            })
        })
        .await
    }

    /// Submit a draft. Under `approval.policy.org_structure = route` it goes
    /// IN_APPROVAL with the ordered steps (BW-01). Under `none` (decisions
    /// #26, the default) no step is created: it is APPROVED at once and, once
    /// its 시행일 has come, applied in the same transaction; a future-dated
    /// one waits as APPROVED for [`Self::effectuate`] on its 시행일.
    pub async fn submit(
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
                // Preflight persists nothing, so a request now reaches submit
                // as DRAFT. Rows written before that change are PRECHECKED on
                // disk and must keep working: both are accepted and the
                // receipt is recomputed below either way.
                if !request.status.is_draft_editable() {
                    return Err(KernelError::conflict(
                        "submit requires a DRAFT or PRECHECKED request",
                    )
                    .into());
                }
                let routed =
                    approval_routes_in_tx(tx.as_mut(), org, SettingKey::ApprovalPolicyOrgStructure)
                        .await?;
                let next = if routed {
                    OrgChangeStatus::InApproval
                } else {
                    OrgChangeStatus::Approved
                };
                request.status.can_transition_to(next)?;
                // Fresh, in-transaction recheck: a stored receipt can go stale
                // between preflight and submit; the current state decides.
                let mut report = compute_preflight(
                    tx,
                    org,
                    request.kind,
                    &request.target,
                    &request.proposal,
                    request.effective_date,
                    now,
                )
                .await?;
                let ports = (employment_transfer.as_deref(), org_unit_write.as_deref());
                dry_run_apply(tx, (org, actor, now), id, &request, ports, &mut report).await?;
                if !report.blockers.is_empty() {
                    tracing::warn!(request = %id, codes = ?report.blockers.iter().map(|b| &b.code).collect::<Vec<_>>(), "org change submit refused by preflight");
                    return Err(PgOrgChangeError::PreflightBlocked(
                        report.blockers.iter().map(|b| b.code.clone()).collect(),
                    ));
                }
                let (site_count, team_count) = proposal_stats(&request.target, &request.proposal);
                store_preflight(tx, id, &report, next, site_count, team_count, now).await?;
                let steps = if routed {
                    &ApprovalRoleKey::ORDER[..]
                } else {
                    &[]
                };
                for (index, role) in steps.iter().enumerate() {
                    sqlx::query(
                        "INSERT INTO org_change_approval_steps \
                         (org_id, request_id, step_order, role_key) VALUES ($1, $2, $3, $4)",
                    )
                    .bind(*org.as_uuid())
                    .bind(id)
                    .bind(i16::try_from(index + 1).unwrap_or(i16::MAX))
                    .bind(role.as_db())
                    .execute(tx.as_mut())
                    .await?;
                }
                insert_event(
                    tx,
                    org,
                    id,
                    actor,
                    "submit",
                    Some(request.status),
                    Some(next),
                    (!routed).then_some("approval.policy=none"),
                    now,
                )
                .await?;
                let mut audits = vec![audit(
                    org,
                    actor,
                    "org_change.submit",
                    "org_change_request",
                    id.to_string(),
                    now,
                )?];
                if !routed && today_kst() >= request.effective_date {
                    let approved = lock_request(tx, id).await?;
                    audits.extend(
                        effectuate_in_tx(
                            tx,
                            (org, actor, now, today_kst()),
                            id,
                            &approved,
                            employment_transfer.as_deref(),
                            org_unit_write.as_deref(),
                        )
                        .await?,
                    );
                }
                let detail = require_detail(tx, id).await?;
                Ok((detail, audits))
            })
        })
        .await;
        self.record_freeze_refusal(org, actor, id, "org_change.submit.refused", outcome)
            .await
    }
}
