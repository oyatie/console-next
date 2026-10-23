use crate::*;

/// Summary reads carry the drafter's display name; `users` is RLS-confined to
/// the tenant, so an unknown drafter is simply null.
pub(crate) const SELECT_REQUEST: &str = "SELECT r.id, r.code, r.kind, r.status, r.target_kind, \
     r.target_ref, r.target_label, r.effective_date, r.reason, r.proposal, r.preflight, \
     r.headcount, r.site_count, r.team_count, r.supersedes_id, r.drafted_by, \
     du.display_name AS drafted_by_name, r.created_at, r.updated_at, \
     (SELECT e.command_id FROM audit_events e WHERE e.org_id=r.org_id \
       AND e.target_type='org_change_request' AND e.target_id=r.id::text \
       AND e.outcome='ALLOWED' AND e.command_id IS NOT NULL \
       ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS command_id \
     FROM org_change_requests r LEFT JOIN person_accounts_current du ON du.id = r.drafted_by \
     WHERE r.id = $1";
pub(crate) const SELECT_REQUEST_FOR_UPDATE: &str = "SELECT id, code, kind, status, target_kind, \
     target_ref, target_label, effective_date, reason, proposal, preflight, headcount, \
     site_count, team_count, supersedes_id, drafted_by, created_at, updated_at \
     FROM org_change_requests WHERE id = $1 FOR UPDATE";
pub(crate) const SELECT_REQUEST_PAGE: &str = "SELECT r.id, r.code, r.kind, r.status, r.target_kind, \
     r.target_ref, r.target_label, r.effective_date, r.reason, r.proposal, r.preflight, \
     r.headcount, r.site_count, r.team_count, r.supersedes_id, r.drafted_by, \
     du.display_name AS drafted_by_name, r.created_at, r.updated_at, \
     (SELECT e.command_id FROM audit_events e WHERE e.org_id=r.org_id \
       AND e.target_type='org_change_request' AND e.target_id=r.id::text \
       AND e.outcome='ALLOWED' AND e.command_id IS NOT NULL \
       ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS command_id \
     FROM org_change_requests r LEFT JOIN person_accounts_current du ON du.id = r.drafted_by \
     WHERE ($1::text[] IS NULL OR r.status = ANY($1)) AND ($2::text IS NULL OR r.kind = $2) \
     AND ($3::uuid IS NULL OR r.drafted_by = $3) \
     AND ($6::date IS NULL OR r.effective_date >= $6) \
     AND ($7::date IS NULL OR r.effective_date <= $7) \
     ORDER BY r.created_at DESC, r.id LIMIT $4 OFFSET $5";

pub(crate) struct RequestRow {
    pub(crate) code: String,
    pub(crate) reason: String,
    pub(crate) kind: OrgChangeKind,
    pub(crate) status: OrgChangeStatus,
    pub(crate) target: OrgChangeTarget,
    pub(crate) effective_date: Date,
    pub(crate) proposal: Vec<OrgProposalOp>,
    pub(crate) drafted_by: Uuid,
}

pub(crate) fn parse_proposal(value: &Value) -> Result<Vec<OrgProposalOp>, PgOrgChangeError> {
    serde_json::from_value(value.clone())
        .map_err(|_| KernelError::internal("stored proposal is not parseable").into())
}

pub(crate) fn request_row(row: &PgRow) -> Result<RequestRow, PgOrgChangeError> {
    let proposal_json: Value = row.try_get("proposal")?;
    Ok(RequestRow {
        code: row.try_get("code")?,
        reason: row.try_get("reason")?,
        kind: OrgChangeKind::from_db(row.try_get::<String, _>("kind")?.as_str())?,
        status: OrgChangeStatus::from_db(row.try_get::<String, _>("status")?.as_str())?,
        target: OrgChangeTarget {
            kind: TargetKind::from_db(row.try_get::<String, _>("target_kind")?.as_str())?,
            target_ref: row.try_get("target_ref")?,
            label: row.try_get("target_label")?,
        },
        effective_date: row.try_get("effective_date")?,
        proposal: parse_proposal(&proposal_json)?,
        drafted_by: row.try_get("drafted_by")?,
    })
}

pub(crate) fn summary_from_row(row: &PgRow) -> Result<OrgChangeSummary, PgOrgChangeError> {
    Ok(OrgChangeSummary {
        id: row.try_get("id")?,
        command_id: row.try_get("command_id")?,
        code: row.try_get("code")?,
        kind: OrgChangeKind::from_db(row.try_get::<String, _>("kind")?.as_str())?,
        status: OrgChangeStatus::from_db(row.try_get::<String, _>("status")?.as_str())?,
        target: OrgChangeTarget {
            kind: TargetKind::from_db(row.try_get::<String, _>("target_kind")?.as_str())?,
            target_ref: row.try_get("target_ref")?,
            label: row.try_get("target_label")?,
        },
        effective_date: row.try_get("effective_date")?,
        reason: row.try_get("reason")?,
        headcount: row.try_get("headcount")?,
        site_count: row.try_get("site_count")?,
        team_count: row.try_get("team_count")?,
        drafted_by: row.try_get("drafted_by")?,
        drafted_by_name: row.try_get("drafted_by_name")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        supersedes_id: row.try_get("supersedes_id")?,
    })
}

pub(crate) fn preflight_from_row(
    row: &PgRow,
    status: OrgChangeStatus,
) -> Result<Option<PreflightReport>, PgOrgChangeError> {
    let raw: Option<Value> = row.try_get("preflight")?;
    let Some(raw) = raw else { return Ok(None) };
    let mut report: PreflightReport = serde_json::from_value(raw)
        .map_err(|_| KernelError::internal("stored preflight receipt is not parseable"))?;
    let updated_at: OffsetDateTime = row.try_get("updated_at")?;
    // A receipt is stale only while the draft is still editable and was
    // edited after the receipt was computed; post-submit receipts were
    // re-verified inside the submit transaction.
    report.stale = status.is_draft_editable() && report.computed_at < updated_at;
    Ok(Some(report))
}
