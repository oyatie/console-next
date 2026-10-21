use crate::*;

impl PgOrgChangeStore {
    pub async fn create(
        &self,
        actor: UserId,
        command: CreateOrgChange,
    ) -> Result<(OrgChangeDetail, bool), PgOrgChangeError> {
        self.create_inner(actor, command, false).await
    }

    /// Compatibility entry point for the six legacy region/branch mutation
    /// URLs. It shares the normal DRAFT/idempotency transaction, then restores
    /// their tenant-scoped target validation without granting the REST adapter
    /// a second SQL writer.
    pub async fn create_legacy_org_setup_proposal(
        &self,
        actor: UserId,
        command: CreateOrgChange,
    ) -> Result<(OrgChangeDetail, bool), PgOrgChangeError> {
        self.create_inner(actor, command, true).await
    }

    pub(crate) async fn create_inner(
        &self,
        actor: UserId,
        command: CreateOrgChange,
        validate_legacy_targets: bool,
    ) -> Result<(OrgChangeDetail, bool), PgOrgChangeError> {
        command.target.validate()?;
        validate_proposal(&command.proposal)?;
        bounded_text(&command.reason, "reason", 4000)?;
        let key = command.idempotency_key.trim();
        // Characters, not bytes — the DB CHECK is char_length(); a byte count
        // would let a short multibyte key through to a raw CHECK violation.
        let key_chars = key.chars().count();
        if !(16..=200).contains(&key_chars) {
            return Err(
                KernelError::validation("Idempotency-Key must be 16..200 characters").into(),
            );
        }
        if command.effective_date < today_kst() {
            return Err(
                KernelError::validation("effectiveDate must be today or later (KST)").into(),
            );
        }
        let org = current_org().map_err(KernelError::from)?;
        let now = OffsetDateTime::now_utc();
        let key = key.to_owned();
        let fp = fingerprint(&command.fingerprint_input);
        let proposal_json = serde_json::to_value(&command.proposal)
            .map_err(|_| KernelError::internal("proposal serialization failed"))?;

        with_audits(&self.pool, org, |tx| {
            Box::pin(async move {
                if let Some(row) = sqlx::query(
                    "SELECT id, request_fingerprint FROM org_change_requests \
                     WHERE idempotency_key = $1",
                )
                .bind(&key)
                .fetch_optional(tx.as_mut())
                .await?
                {
                    let prior: String = row.try_get("request_fingerprint")?;
                    if prior != fp {
                        return Err(KernelError::conflict(
                            "idempotency key was reused with a different request",
                        )
                        .into());
                    }
                    let id: Uuid = row.try_get("id")?;
                    let detail = require_detail(tx, id).await?;
                    return Ok(((detail, true), vec![]));
                }

                if validate_legacy_targets {
                    validate_legacy_org_setup_targets(tx, &command.proposal).await?;
                }
                require_org_unit_refs_visible(tx, org, &command.proposal).await?;

                if let Some(supersedes) = command.supersedes_id {
                    let status: Option<String> = sqlx::query_scalar(
                        "SELECT status FROM org_change_requests WHERE id = $1",
                    )
                    .bind(supersedes)
                    .fetch_optional(tx.as_mut())
                    .await?;
                    match status.as_deref() {
                        None => {
                            return Err(KernelError::not_found(
                                "superseded org-change request was not found",
                            )
                            .into());
                        }
                        Some("REJECTED") => {}
                        Some(_) => {
                            return Err(KernelError::conflict(
                                "only a REJECTED request can be superseded by a revision",
                            )
                            .into());
                        }
                    }
                }

                let year = today_kst().year();
                let prefix = format!("OC-{year}-");
                // Numeric max, not lexicographic: 'OC-2026-9999' > 'OC-2026-10000'
                // as text, which would repeat 10000 forever (permanent 409s).
                let last: Option<i64> = sqlx::query_scalar(
                    "SELECT max((substring(code FROM 9))::bigint) \
                     FROM org_change_requests WHERE code LIKE $1",
                )
                .bind(format!("{prefix}%"))
                .fetch_one(tx.as_mut())
                .await?;
                let next = last.unwrap_or(0) + 1;
                let code = format!("{prefix}{next:04}");

                let id = Uuid::new_v4();
                sqlx::query(
                    "INSERT INTO org_change_requests \
                     (id, org_id, code, kind, status, target_kind, target_ref, target_label, \
                      effective_date, reason, proposal, supersedes_id, drafted_by, \
                      idempotency_key, request_fingerprint, created_at, updated_at) \
                     VALUES ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)",
                )
                .bind(id)
                .bind(*org.as_uuid())
                .bind(&code)
                .bind(command.kind.as_db())
                .bind(command.target.kind.as_db())
                .bind(&command.target.target_ref)
                .bind(&command.target.label)
                .bind(command.effective_date)
                .bind(&command.reason)
                .bind(&proposal_json)
                .bind(command.supersedes_id)
                .bind(*actor.as_uuid())
                .bind(&key)
                .bind(&fp)
                .bind(now)
                .execute(tx.as_mut())
                .await?;

                insert_event(
                    tx,
                    org,
                    id,
                    actor,
                    "create",
                    None,
                    Some(OrgChangeStatus::Draft),
                    Some(&command.reason),
                    now,
                )
                .await?;
                let detail = require_detail(tx, id).await?;
                Ok((
                    (detail, false),
                    vec![audit(
                        org,
                        actor,
                        "org_change.create",
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
