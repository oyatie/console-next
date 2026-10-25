use crate::*;

/// A scheduled change (APPROVED, its 시행일 not come) is its drafter's to
/// move or cancel under `approval.policy.org_structure = none` (decisions
/// #26); once a routed change is approved, only someone who may apply it
/// changes it (403 `org_change_scheduled_locked`).
pub(crate) async fn may_touch_scheduled(
    tx: Tx<'_, '_>,
    org: OrgId,
    request: &RequestRow,
    holds_apply: bool,
) -> Result<(), PgOrgChangeError> {
    if request.status == OrgChangeStatus::Approved
        && !holds_apply
        && approval_routes_in_tx(tx.as_mut(), org, SettingKey::ApprovalPolicyOrgStructure).await?
    {
        return Err(KernelError::forbidden(
            "an approved change is moved or cancelled by someone who may apply it",
        )
        .with_code(ORG_CHANGE_SCHEDULED_LOCKED)
        .into());
    }
    Ok(())
}

/// 예약 수정 (org-02): a scheduled change keeps its content and moves its
/// 시행일 and/or reason. Moved to today, it applies at once, as a change
/// dated today does on submit.
pub(crate) async fn reschedule_in_tx(
    tx: Tx<'_, '_>,
    (org, actor, now): (OrgId, UserId, OffsetDateTime),
    id: Uuid,
    patch: &DraftPatch,
    ports: (
        Option<&dyn EmploymentTransferPort>,
        Option<&dyn OrgUnitWritePort>,
    ),
) -> Result<Vec<AuditEvent>, PgOrgChangeError> {
    if patch.kind.is_some() || patch.proposal.is_some() {
        return Err(KernelError::conflict(
            "a scheduled change keeps its content; cancel it and draft a new one",
        )
        .with_code(ORG_CHANGE_SCHEDULED_CONTENT)
        .into());
    }
    sqlx::query(
        "UPDATE org_change_requests SET effective_date = COALESCE($2, effective_date), \
         reason = COALESCE($3, reason), updated_at = $4 WHERE id = $1",
    )
    .bind(id)
    .bind(patch.effective_date)
    .bind(patch.reason.as_deref())
    .bind(now)
    .execute(tx.as_mut())
    .await?;
    let moved = lock_request(tx, id).await?;
    insert_event(
        tx,
        org,
        id,
        actor,
        "reschedule",
        Some(OrgChangeStatus::Approved),
        Some(OrgChangeStatus::Approved),
        Some(&format!("effectiveDate={}", moved.effective_date)),
        now,
    )
    .await?;
    let mut audits = vec![audit(
        org,
        actor,
        "org_change.draft.update",
        "org_change_request",
        id.to_string(),
        now,
    )?];
    let today = today_kst();
    if today >= moved.effective_date {
        let (people, units) = ports;
        audits.extend(
            effectuate_in_tx(tx, (org, actor, now, today), id, &moved, people, units).await?,
        );
    }
    Ok(audits)
}

impl PgOrgChangeStore {
    /// The scheduled-change worker's one call (org-02): applies every APPROVED
    /// change whose 시행일 is `through` or earlier, in every tenant, oldest
    /// first, each in its own audited transaction (the same apply a submit or
    /// 시행 runs; its audits feed the event stream, decisions #27). A refused
    /// change stays APPROVED with the refusal on its record (once per reason),
    /// so its page says why and offers 예약 수정 · 예약 취소; a server fault
    /// is retried next run. Idempotent across replicas: the row lock and the
    /// re-read status admit each change once. Returns how many applied.
    pub async fn effectuate_due(&self, through: Date) -> Result<usize, String> {
        self.effectuate_due_at(through, OffsetDateTime::now_utc())
            .await
    }

    /// The worker's UTC clock is explicit so the configured boundary is reproducible.
    pub async fn effectuate_due_at(
        &self,
        today: Date,
        now: OffsetDateTime,
    ) -> Result<usize, String> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_org_conn / with_audits
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        let mut applied = 0;
        for org_uuid in orgs {
            let org = OrgId::from_uuid(org_uuid);
            let due = with_org_conn(&self.pool, org, move |tx| {
                Box::pin(async move {
                    let at = apply_time_in_tx(tx, org, now).await?;
                    let through = due_through(today, now, at);
                    tracing::info!(org = %org, key = SettingKey::OrgChangeApplyTime.as_str(), value = %at, %through, "scheduled org change apply time resolved");
                    let due: Vec<Uuid> = sqlx::query_scalar(
                        "SELECT id FROM org_change_requests WHERE status = 'APPROVED' \
                         AND effective_date <= $1 ORDER BY effective_date, created_at LIMIT 200",
                    )
                    .bind(through)
                    .fetch_all(tx.as_mut())
                    .await?;
                    Ok::<_, PgOrgChangeError>((through, due))
                })
            })
            .await;
            let (through, due) = match due {
                Ok(due) => due,
                Err(error) => {
                    tracing::warn!(org = %org, error = %error.message(), "due org changes could not be listed; retrying next run");
                    continue;
                }
            };
            for id in due {
                match self.effectuate_scheduled(org, id, through).await {
                    Ok(true) => applied += 1,
                    Ok(false) => {}
                    Err(error) => {
                        tracing::warn!(org = %org, change = %id, error = %error.message(), "scheduled org change did not apply")
                    }
                }
            }
        }
        Ok(applied)
    }

    /// One due change, as its drafter (the change is theirs; the event says it
    /// was the schedule that applied it). `false` when it is no longer due.
    async fn effectuate_scheduled(
        &self,
        org: OrgId,
        id: Uuid,
        through: Date,
    ) -> Result<bool, PgOrgChangeError> {
        let now = OffsetDateTime::now_utc();
        let (people, units) = (self.employment_transfer(), self.org_unit_write.clone());
        let outcome = with_audits(&self.pool, org, move |tx| {
            Box::pin(async move {
                let request = lock_request(tx, id).await?;
                if request.status != OrgChangeStatus::Approved || request.effective_date > through {
                    return Ok::<_, PgOrgChangeError>((false, vec![]));
                }
                let actor = UserId::from_uuid(request.drafted_by);
                let audits = effectuate_in_tx(
                    tx,
                    (org, actor, now, through),
                    id,
                    &request,
                    people.as_deref(),
                    units.as_deref(),
                )
                .await?;
                let audits = audits
                    .into_iter()
                    .map(|event| event.with_source(console_kernel_core::AuditSource::Scheduler))
                    .collect();
                Ok((true, audits))
            })
        })
        .await;
        match outcome {
            Err(error) if error.kind() != ErrorKind::Internal => {
                self.note_refusal(org, id, &error).await?;
                Err(error)
            }
            other => other,
        }
    }

    /// Records why a due change did not apply, once per distinct reason.
    async fn note_refusal(
        &self,
        org: OrgId,
        id: Uuid,
        error: &PgOrgChangeError,
    ) -> Result<(), PgOrgChangeError> {
        let detail: String = error.message().chars().take(500).collect();
        with_org_conn(&self.pool, org, move |tx| {
            Box::pin(async move {
                let request = lock_request(tx, id).await?;
                let seen: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM org_change_events WHERE request_id = $1 \
                     AND action = 'effectuate.refused' AND reason = $2)",
                )
                .bind(id)
                .bind(&detail)
                .fetch_one(tx.as_mut())
                .await?;
                if !seen {
                    let actor = UserId::from_uuid(request.drafted_by);
                    let now = OffsetDateTime::now_utc();
                    insert_event(
                        tx,
                        org,
                        id,
                        actor,
                        "effectuate.refused",
                        None,
                        None,
                        Some(&detail),
                        now,
                    )
                    .await?;
                }
                Ok(())
            })
        })
        .await
    }
}
