use crate::*;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub(crate) async fn legacy_create_region(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Json(b): Json<LegacyCreateRegionRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    let name = b.name.trim().to_owned();
    draft_legacy_org_proposal(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::New,
        OrgChangeTarget {
            kind: TargetKind::Region,
            target_ref: Uuid::nil().to_string(),
            label: name.clone(),
        },
        "Create region requested through the legacy org-setup API",
        vec![OrgProposalOp::CreateRegion { name }],
    )
    .await
}

pub(crate) async fn legacy_update_region(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<LegacyUpdateRegionRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    let name = b.name.trim().to_owned();
    draft_legacy_org_proposal(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::Reorg,
        OrgChangeTarget {
            kind: TargetKind::Region,
            target_ref: id.to_string(),
            label: name.clone(),
        },
        "Rename region requested through the legacy org-setup API",
        vec![OrgProposalOp::RenameRegion {
            region_id: id,
            name,
        }],
    )
    .await
}

pub(crate) async fn legacy_deactivate_region(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    draft_legacy_org_proposal(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::Dissolve,
        OrgChangeTarget {
            kind: TargetKind::Region,
            target_ref: id.to_string(),
            label: format!("Region {id}"),
        },
        "Deactivate region requested through the legacy org-setup API",
        vec![OrgProposalOp::DeactivateRegion { region_id: id }],
    )
    .await
}

pub(crate) async fn legacy_create_branch(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Json(b): Json<LegacyCreateBranchRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    let name = b.name.trim().to_owned();
    draft_legacy_org_proposal(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::New,
        OrgChangeTarget {
            kind: TargetKind::Region,
            target_ref: b.region_id.to_string(),
            label: name.clone(),
        },
        "Create branch requested through the legacy org-setup API",
        vec![OrgProposalOp::CreateBranch {
            region_id: b.region_id,
            name,
        }],
    )
    .await
}

pub(crate) async fn legacy_update_branch(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
    Json(b): Json<LegacyUpdateBranchRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    conceal_out_of_scope_branch(&p, id)?;
    let name = b.name.map(|name| name.trim().to_owned());
    let label = name.clone().unwrap_or_else(|| format!("Branch {id}"));
    draft_legacy_org_proposal(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::Reorg,
        OrgChangeTarget {
            kind: TargetKind::Branch,
            target_ref: id.to_string(),
            label,
        },
        "Update branch requested through the legacy org-setup API",
        vec![OrgProposalOp::RenameBranch {
            branch_id: id,
            name,
            region_id: b.region_id,
        }],
    )
    .await
}

pub(crate) async fn legacy_deactivate_branch(
    State(s): State<OrgChangeRestState>,
    h: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let p = principal(&s, &h).await?;
    conceal_out_of_scope_branch(&p, id)?;
    draft_legacy_org_proposal(
        &s,
        &h,
        p.user_id,
        OrgChangeKind::Dissolve,
        OrgChangeTarget {
            kind: TargetKind::Branch,
            target_ref: id.to_string(),
            label: format!("Branch {id}"),
        },
        "Deactivate branch requested through the legacy org-setup API",
        vec![OrgProposalOp::DeactivateBranch { branch_id: id }],
    )
    .await
}

pub(crate) async fn draft_legacy_org_proposal(
    s: &OrgChangeRestState,
    h: &HeaderMap,
    actor: UserId,
    kind: OrgChangeKind,
    target: OrgChangeTarget,
    reason: &'static str,
    proposal: Vec<OrgProposalOp>,
) -> Result<(StatusCode, Json<serde_json::Value>), RestError> {
    let idempotency_key = idem_header(h)?;
    let effective_date = OffsetDateTime::now_utc().to_offset(offset!(+9)).date();
    // `effective_date` is a server-owned default, not part of the caller's
    // request. Keep it out of the fingerprint so an exact retry that crosses
    // KST midnight still replays the original draft instead of conflicting.
    let fingerprint_input = json!({
        "surface": "identity.org-structure-proposal",
        "kind": kind,
        "target": target,
        "reason": reason,
        "proposal": proposal,
    });
    let (detail, replayed) = s
        .store
        .create_legacy_org_setup_proposal(
            actor,
            CreateOrgChange {
                kind,
                target,
                effective_date,
                reason: reason.to_owned(),
                proposal,
                supersedes_id: None,
                idempotency_key,
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
