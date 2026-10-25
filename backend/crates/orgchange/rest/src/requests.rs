use crate::*;

pub(crate) async fn create(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Json(b): Json<CreateOrgChangeRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    allow_draft(&p)?;
    let key = idem_header(&h)?;
    let fingerprint_input = serde_json::to_value(&b)
        .map_err(|_| RestError::kernel(KernelError::validation("request body is not canonical")))?;
    let (detail, replayed) = s
        .store
        .create(
            p.user_id,
            CreateOrgChange {
                kind: b.kind,
                target: b.target,
                effective_date: b.effective_date,
                reason: b.reason,
                proposal: b.proposal,
                supersedes_id: b.supersedes_id,
                idempotency_key: key,
                fingerprint_input,
            },
        )
        .await
        .map_err(RestError::store)?;
    let status = if replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    let body = serde_json::to_value(&detail)
        .map_err(|_| RestError::internal("response serialization failed"))?;
    Ok((status, Json(body)))
}

pub(crate) async fn list(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Query(q): Query<ListQuery>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_read(&p)?;
    let statuses = q
        .status
        .as_deref()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(OrgChangeStatus::from_db)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()
        .map_err(|_| RestError::kernel(KernelError::validation("unknown status filter")))?
        .unwrap_or_default();
    let kind = q
        .kind
        .as_deref()
        .map(OrgChangeKind::from_db)
        .transpose()
        .map_err(|_| RestError::kernel(KernelError::validation("unknown kind filter")))?;
    let (effective_from, effective_to) = match crate::filters::effective_dates(&q) {
        Ok(dates) => dates,
        Err(error) => {
            s.store
                .record_date_filter_refusal(p.user_id)
                .await
                .map_err(RestError::store)?;
            return Err(RestError::kernel(error));
        }
    };
    let page = s
        .store
        .list(ListFilter {
            target_ref: q.target_ref,
            statuses,
            kind,
            drafted_by: q.drafted_by,
            effective_from,
            effective_to,
            limit: q.limit,
            offset: q.offset,
        })
        .await
        .map_err(RestError::store)?;
    respond(&page)
}

pub(crate) async fn detail(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_read(&p)?;
    respond(&s.store.get(id).await.map_err(RestError::store)?)
}

pub(crate) async fn update_draft(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<UpdateOrgChangeDraftRequest>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_draft(&p)?;
    // A scheduled change under routing is moved only by someone who may apply it.
    let holds_apply = allow_apply(&p).is_ok();
    respond(
        &s.store
            .update_draft(
                p.user_id,
                id,
                DraftPatch {
                    kind: b.kind,
                    effective_date: b.effective_date,
                    reason: b.reason,
                    proposal: b.proposal,
                },
                holds_apply,
            )
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn preflight(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_draft(&p)?;
    respond(
        &s.store
            .preflight(p.user_id, id)
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn submit(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_draft(&p)?;
    respond(
        &s.store
            .submit(p.user_id, id)
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn decide(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path((id, step_id)): Path<(Uuid, Uuid)>,
    Json(b): Json<OrgChangeDecisionRequest>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_approve(&p)?;
    let approved = matches!(b.decision, WireDecision::Approved);
    respond(
        &s.store
            .decide_step(p.user_id, id, step_id, approved, b.memo)
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn effectuate(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    // Under approval.policy.org_structure = none (decisions #26) a drafter
    // applies their own change on its 시행일; the store decides in-tx.
    let holds_apply = allow_apply(&p).is_ok();
    if !holds_apply {
        allow_draft(&p)?;
    }
    respond(
        &s.store
            .effectuate(p.user_id, id, holds_apply)
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn complete_settlement(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path((id, item_id)): Path<(Uuid, Uuid)>,
    Json(b): Json<CompleteSettlementItemRequest>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_apply(&p)?;
    respond(
        &s.store
            .complete_settlement_item(p.user_id, id, item_id, b.memo)
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn archive(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_apply(&p)?;
    respond(
        &s.store
            .archive(p.user_id, id)
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn cancel(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<CancelOrgChangeRequest>,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_draft(&p)?;
    // A scheduled change under routing is cancelled only by someone who may apply it.
    let holds_apply = allow_apply(&p).is_ok();
    respond(
        &s.store
            .cancel(p.user_id, id, b.reason, holds_apply)
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn org_entities(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
) -> Result<Json<serde_json::Value>, RestError> {
    let p = principal(&s, &h).await?;
    allow_read(&p)?;
    respond(
        &s.store
            .org_entities(p.user_id)
            .await
            .map_err(RestError::store)?,
    )
}

pub(crate) async fn list_visible_org_entities(
    state: &OrgChangeRestState,
    headers: &HeaderMap,
) -> Result<Vec<VisibleOrgEntity>, RestError> {
    let principal = principal(state, headers).await?;
    allow_read(&principal)?;
    let entities = state
        .store
        .org_entities(principal.user_id)
        .await
        .map_err(RestError::store)?;
    Ok(entities
        .into_iter()
        .map(|entity| VisibleOrgEntity {
            org_id: entity.org_id.to_string(),
            slug: entity.slug,
            name: entity.name,
            status: entity.status,
        })
        .collect())
}
