use crate::*;

impl PgOrgChangeStore {
    pub async fn decide_step(
        &self,
        actor: UserId,
        id: Uuid,
        step_id: Uuid,
        approved: bool,
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
                if request.status != OrgChangeStatus::InApproval {
                    return Err(KernelError::conflict(
                        "approval decisions apply only while the request is IN_APPROVAL",
                    )
                    .into());
                }
                if !console_platform_authz::cedar_pbac::actions::independent_people::authorized_in_tx(
                    tx, Some(request.drafted_by), *actor.as_uuid(),
                ).await? {
                    return Err(KernelError::conflict(
                        "기안자 본인은 결재할 수 없으며, 신원 정보를 확인할 수 없어도 결재를 거부합니다. 결재 권한이 있는 다른 사람이 결재해야 합니다.",
                    ).with_code("org_change_sod_violation")
                    .into());
                }
                let step = sqlx::query(
                    "SELECT step_order, role_key, decision FROM org_change_approval_steps \
                     WHERE id = $1 AND request_id = $2 FOR UPDATE",
                )
                .bind(step_id)
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| KernelError::not_found("approval step was not found"))?;
                let step_order: i16 = step.try_get("step_order")?;
                let role_key: String = step.try_get("role_key")?;
                let decision =
                    StepDecision::from_db(step.try_get::<String, _>("decision")?.as_str())?;
                if decision != StepDecision::Pending {
                    return Err(KernelError::conflict("approval step is already decided").into());
                }
                let lowest_pending: Option<i16> = sqlx::query_scalar(
                    "SELECT min(step_order) FROM org_change_approval_steps \
                     WHERE request_id = $1 AND decision = 'PENDING'",
                )
                .bind(id)
                .fetch_one(tx.as_mut())
                .await?;
                if lowest_pending != Some(step_order) {
                    return Err(
                        KernelError::conflict("approval steps must be decided in order").into(),
                    );
                }

                // Record the decision through gov_approvals so the DB-level
                // approver <> requester CHECK is the second SoD net.
                sqlx::query(
                    "INSERT INTO gov_approvals \
                     (org_id, request_ref, kind, requested_by, approver_id, decision, decided_at) \
                     VALUES ($1, $2, 'org_change_step', $3, $4, $5, $6)",
                )
                .bind(*org.as_uuid())
                .bind(step_id)
                .bind(request.drafted_by)
                .bind(*actor.as_uuid())
                .bind(if approved { "approved" } else { "rejected" })
                .bind(now)
                .execute(tx.as_mut())
                .await?;

                let next_decision = if approved {
                    StepDecision::Approved
                } else {
                    StepDecision::Rejected
                };
                sqlx::query(
                    "UPDATE org_change_approval_steps SET decision = $2, decided_by = $3, \
                     decided_at = $4, memo = $5 WHERE id = $1",
                )
                .bind(step_id)
                .bind(next_decision.as_db())
                .bind(*actor.as_uuid())
                .bind(now)
                .bind(memo.as_deref())
                .execute(tx.as_mut())
                .await?;

                let next_status = if approved {
                    let pending: i64 = sqlx::query_scalar(
                        "SELECT count(*) FROM org_change_approval_steps \
                         WHERE request_id = $1 AND decision = 'PENDING'",
                    )
                    .bind(id)
                    .fetch_one(tx.as_mut())
                    .await?;
                    if pending == 0 {
                        Some(OrgChangeStatus::Approved)
                    } else {
                        None
                    }
                } else {
                    Some(OrgChangeStatus::Rejected)
                };
                if let Some(next) = next_status {
                    request.status.can_transition_to(next)?;
                    sqlx::query(
                        "UPDATE org_change_requests SET status = $2, updated_at = $3 WHERE id = $1",
                    )
                    .bind(id)
                    .bind(next.as_db())
                    .bind(now)
                    .execute(tx.as_mut())
                    .await?;
                }
                insert_event(
                    tx,
                    org,
                    id,
                    actor,
                    "step.decide",
                    Some(request.status),
                    next_status,
                    Some(&format!("{role_key}:{}", next_decision.as_db())),
                    now,
                )
                .await?;
                let detail = require_detail(tx, id).await?;
                Ok((
                    detail,
                    vec![audit(
                        org,
                        actor,
                        "org_change.step.decide",
                        "org_change_approval_step",
                        step_id.to_string(),
                        now,
                    )?],
                ))
            })
        })
        .await
    }

    /// Commit the §3.10-⑥ detection record for a freeze-window refusal.
    ///
    /// The refused business transaction rolled back and took every audit row
    /// inside it with it, so the attempt is recorded in its own transaction —
    /// otherwise a blocked apply would leave no trace that it was tried.
    /// Anything but a `Frozen` outcome passes through untouched.
    pub(crate) async fn record_freeze_refusal(
        &self,
        org: OrgId,
        actor: UserId,
        id: Uuid,
        action: &str,
        outcome: Result<OrgChangeDetail, PgOrgChangeError>,
    ) -> Result<OrgChangeDetail, PgOrgChangeError> {
        let Err(PgOrgChangeError::Frozen(refusal)) = &outcome else {
            return outcome;
        };
        let event = audit(
            org,
            actor,
            action,
            "org_change_request",
            id.to_string(),
            OffsetDateTime::now_utc(),
        )?
        .with_classification(AuditClassification {
            badges: None,
            anomaly: Some(true),
            reason: Some(refusal.message.clone()),
        });
        with_audit(&self.pool, event, |_tx| {
            Box::pin(async { Ok::<(), PgOrgChangeError>(()) })
        })
        .await?;
        outcome
    }
}
