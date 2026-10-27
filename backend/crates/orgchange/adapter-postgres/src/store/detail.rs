use crate::*;

pub(crate) async fn load_detail(
    tx: Tx<'_, '_>,
    id: Uuid,
) -> Result<Option<OrgChangeDetail>, PgOrgChangeError> {
    let Some(row) = sqlx::query(SELECT_REQUEST)
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
    else {
        return Ok(None);
    };
    let now = OffsetDateTime::now_utc();
    let org = current_org().map_err(KernelError::from)?;
    let at = apply_time_in_tx(tx, org, now).await?;
    let summary = summary_from_row(tx, &row, at, now).await?;
    let proposal_json: Value = row.try_get("proposal")?;
    let proposal = parse_proposal(&proposal_json)?;
    let preflight = preflight_from_row(&row, summary.status)?;

    let step_rows = sqlx::query(
        "SELECT s.id, s.step_order, s.role_key, s.decision, s.decided_by, \
         u.display_name AS decided_by_name, s.decided_at, s.memo \
         FROM org_change_approval_steps s LEFT JOIN person_accounts_current u ON u.id = s.decided_by \
         WHERE s.request_id = $1 ORDER BY s.step_order",
    )
    .bind(id)
    .fetch_all(tx.as_mut())
    .await?;
    let mut approval_steps = Vec::with_capacity(step_rows.len());
    for step in &step_rows {
        approval_steps.push(ApprovalStepView {
            id: step.try_get("id")?,
            step_order: step.try_get("step_order")?,
            role_key: ApprovalRoleKey::from_db(step.try_get::<String, _>("role_key")?.as_str())?,
            decision: StepDecision::from_db(step.try_get::<String, _>("decision")?.as_str())?,
            decided_by: step.try_get("decided_by")?,
            decided_by_name: step.try_get("decided_by_name")?,
            decided_at: step.try_get("decided_at")?,
            memo: step.try_get("memo")?,
        });
    }

    let item_rows = sqlx::query(
        "SELECT i.id, i.item_key, i.done, i.done_by, u.display_name AS done_by_name, \
         i.done_at, i.memo \
         FROM org_change_settlement_items i LEFT JOIN person_accounts_current u ON u.id = i.done_by \
         WHERE i.request_id = $1",
    )
    .bind(id)
    .fetch_all(tx.as_mut())
    .await?;
    let mut settlement_items = Vec::with_capacity(item_rows.len());
    for item in &item_rows {
        let key = item.try_get::<String, _>("item_key")?;
        let key = SettlementKey::ALL
            .into_iter()
            .find(|k| k.as_db() == key)
            .ok_or_else(|| KernelError::internal("unknown settlement item key"))?;
        settlement_items.push(SettlementItemView {
            id: item.try_get("id")?,
            item_key: key,
            label: key.label().to_owned(),
            done: item.try_get("done")?,
            done_by: item.try_get("done_by")?,
            done_by_name: item.try_get("done_by_name")?,
            done_at: item.try_get("done_at")?,
            memo: item.try_get("memo")?,
        });
    }
    // Design order (§3.9.3), not key order.
    settlement_items.sort_by_key(|item| {
        SettlementKey::ALL
            .iter()
            .position(|k| *k == item.item_key)
            .unwrap_or(usize::MAX)
    });

    let event_rows = sqlx::query(
        "SELECT e.actor, u.display_name AS actor_name, e.action, e.from_status, \
         e.to_status, e.reason, e.created_at \
         FROM org_change_events e LEFT JOIN person_accounts_current u ON u.id = e.actor \
         WHERE e.request_id = $1 ORDER BY e.created_at, e.id",
    )
    .bind(id)
    .fetch_all(tx.as_mut())
    .await?;
    let mut events = Vec::with_capacity(event_rows.len());
    for event in &event_rows {
        events.push(OrgChangeEventView {
            at: event.try_get("created_at")?,
            actor: event.try_get("actor")?,
            actor_name: event.try_get("actor_name")?,
            action: event.try_get("action")?,
            from_status: event.try_get("from_status")?,
            to_status: event.try_get("to_status")?,
            reason: event.try_get("reason")?,
        });
    }

    Ok(Some(OrgChangeDetail {
        version: console_orgchange_domain::decision_version(
            row.try_get("updated_at")?,
            approval_steps.iter().filter_map(|s| s.decided_at).max(),
        ),
        summary,
        proposal,
        preflight,
        approval_steps,
        settlement_items,
        events,
    }))
}

pub(crate) async fn require_detail(
    tx: Tx<'_, '_>,
    id: Uuid,
) -> Result<OrgChangeDetail, PgOrgChangeError> {
    load_detail(tx, id)
        .await?
        .ok_or_else(|| KernelError::internal("org-change request vanished mid-transaction").into())
}

pub(crate) async fn lock_request(tx: Tx<'_, '_>, id: Uuid) -> Result<RequestRow, PgOrgChangeError> {
    let row = sqlx::query(SELECT_REQUEST_FOR_UPDATE)
        .bind(id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| KernelError::not_found("org-change request was not found"))?;
    request_row(&row)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_event(
    tx: Tx<'_, '_>,
    org: OrgId,
    request_id: Uuid,
    actor: UserId,
    action: &str,
    from_status: Option<OrgChangeStatus>,
    to_status: Option<OrgChangeStatus>,
    reason: Option<&str>,
    at: OffsetDateTime,
) -> Result<(), PgOrgChangeError> {
    sqlx::query(
        "INSERT INTO org_change_events \
         (org_id, request_id, actor, action, from_status, to_status, reason, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(*org.as_uuid())
    .bind(request_id)
    .bind(*actor.as_uuid())
    .bind(action)
    .bind(from_status.map(OrgChangeStatus::as_db))
    .bind(to_status.map(OrgChangeStatus::as_db))
    .bind(reason)
    .bind(at)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Preflight computation (deterministic, in the caller's transaction)
// ---------------------------------------------------------------------------

pub(crate) async fn count_by_uuid(
    tx: Tx<'_, '_>,
    sql: &'static str,
    bind: Uuid,
) -> Result<i64, PgOrgChangeError> {
    Ok(sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(tx.as_mut())
        .await?)
}

pub(crate) async fn count_by_text(
    tx: Tx<'_, '_>,
    sql: &'static str,
    bind: &str,
) -> Result<i64, PgOrgChangeError> {
    Ok(sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(tx.as_mut())
        .await?)
}
