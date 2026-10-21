//! Change set reads, open (get-or-create) and discard, plus the owner-scoped
//! lock every write takes first.

use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::{Value, json};
use sqlx::postgres::PgRow;
use sqlx::{Postgres, Row, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use super::{
    ChangeSetDetail, ChangeSetLine, ChangeSetSummary, LineClassification, OpenChangeSetRequest,
    normalize_intent,
};
use crate::authz::authorize_hr_org_wide;
use crate::{HrError, HrService};

/// The audit row of a draft write: ids only, never the line's text.
pub(super) fn draft_audit(
    org: OrgId,
    actor: UserId,
    action: &str,
    set: Uuid,
    after: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "change_set",
        set.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(None, Some(after)))
}

pub(super) fn not_found() -> HrError {
    HrError::from_kernel(KernelError::not_found("change set not found"))
}

/// Locks the caller's set and returns its intent; 404 for anyone else's (or
/// none), 409 `invalid_transition` once it is committed or discarded.
pub(super) async fn lock_open_set(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    owner: Uuid,
    id: Uuid,
) -> Result<String, HrError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT intent, state FROM change_sets \
         WHERE org_id = $1 AND id = $2 AND created_by = $3 FOR UPDATE",
    )
    .bind(org)
    .bind(id)
    .bind(owner)
    .fetch_optional(tx.as_mut())
    .await?;
    match row {
        Some((intent, state)) if state == "OPEN" => Ok(intent),
        Some((_, state)) => Err(HrError::from_kernel(KernelError::invalid_transition(
            format!("change set is {state}; only an OPEN change set changes"),
        ))),
        None => Err(not_found()),
    }
}

fn summary_from_row(row: &PgRow) -> Result<ChangeSetSummary, HrError> {
    Ok(ChangeSetSummary {
        id: row.try_get("id")?,
        intent: row.try_get("intent")?,
        state: row.try_get("state")?,
        batch_id: row.try_get("batch_id")?,
        line_count: row.try_get("line_count")?,
        stale_count: row.try_get("stale_count")?,
        created_at: row.try_get("created_at")?,
    })
}

/// The owner's sets: OPEN ones when `id` is None, else that one in any state.
pub(super) async fn load_summaries(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    owner: Uuid,
    id: Option<Uuid>,
) -> Result<Vec<ChangeSetSummary>, HrError> {
    sqlx::query(
        "SELECT s.id, s.intent, s.state, s.batch_id, s.created_at, \
                count(l.id) AS line_count, \
                count(l.id) FILTER (WHERE l.expected_head_version <> e.head_version) AS stale_count \
         FROM change_sets s \
         LEFT JOIN change_set_lines l ON l.org_id = s.org_id AND l.change_set_id = s.id \
         LEFT JOIN employees e ON e.org_id = l.org_id AND e.id = l.employee_id \
         WHERE s.org_id = $1 AND s.created_by = $2 \
           AND (($3::uuid IS NULL AND s.state = 'OPEN') OR s.id = $3) \
         GROUP BY s.org_id, s.id ORDER BY s.created_at, s.id",
    )
    .bind(org)
    .bind(owner)
    .bind(id)
    .fetch_all(tx.as_mut())
    .await?
    .iter()
    .map(summary_from_row)
    .collect()
}

/// A set's lines (or the one `line`), with the live version and the count of
/// other OPEN drafts touching the same employee.
pub(super) async fn load_lines(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    set: Uuid,
    line: Option<Uuid>,
) -> Result<Vec<ChangeSetLine>, HrError> {
    let rows = sqlx::query(
        "SELECT l.id, l.employee_id, l.expected_head_version, e.head_version, l.effective_date, \
                l.to_org_unit_id, l.to_job_title_id, l.to_position, l.reason_code, l.comment, \
                l.to_grade_id, l.to_position_kind_id, l.vacate_position_kind, l.to_job_id, l.to_job, \
                l.to_job_family_id, l.to_employment_type, l.contract_end_date, \
                (SELECT count(*) FROM change_set_lines o \
                   JOIN change_sets s ON s.org_id = o.org_id AND s.id = o.change_set_id \
                  WHERE o.org_id = l.org_id AND o.employee_id = l.employee_id \
                    AND o.change_set_id <> l.change_set_id AND s.state = 'OPEN') AS other_open_drafts \
         FROM change_set_lines l JOIN employees e ON e.org_id = l.org_id AND e.id = l.employee_id \
         WHERE l.org_id = $1 AND l.change_set_id = $2 AND ($3::uuid IS NULL OR l.id = $3) \
         ORDER BY l.created_at, l.id",
    )
    .bind(org)
    .bind(set)
    .bind(line)
    .fetch_all(tx.as_mut())
    .await?;
    rows.iter()
        .map(|row| {
            let pinned: i32 = row.try_get("expected_head_version")?;
            let head: i32 = row.try_get("head_version")?;
            let effective: Date = row.try_get("effective_date")?;
            Ok(ChangeSetLine {
                id: row.try_get("id")?,
                employee_id: row.try_get("employee_id")?,
                expected_head_version: pinned,
                head_version: head,
                stale: pinned != head,
                other_open_drafts: row.try_get("other_open_drafts")?,
                effective_date: effective.to_string(),
                to_org_unit_id: row.try_get("to_org_unit_id")?,
                to_job_title_id: row.try_get("to_job_title_id")?,
                to_position: row.try_get("to_position")?,
                reason_code: row.try_get("reason_code")?,
                classify: line_classification(row)?,
                comment: row.try_get("comment")?,
            })
        })
        .collect()
}

/// The MR-24/25 columns of a `change_set_lines` row (any query selecting them).
pub(super) fn line_classification(row: &PgRow) -> Result<LineClassification, HrError> {
    let contract_end: Option<Date> = row.try_get("contract_end_date")?;
    Ok(LineClassification {
        to_grade_id: row.try_get("to_grade_id")?,
        to_position_kind_id: row.try_get("to_position_kind_id")?,
        vacate_position_kind: row.try_get("vacate_position_kind")?,
        to_job_id: row.try_get("to_job_id")?,
        to_job: row.try_get("to_job")?,
        to_job_family_id: row.try_get("to_job_family_id")?,
        to_employment_type: row.try_get("to_employment_type")?,
        contract_end_date: contract_end.map(|day| day.to_string()),
    })
}

pub(super) async fn load_detail(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    owner: Uuid,
    id: Uuid,
) -> Result<ChangeSetDetail, HrError> {
    let summary = load_summaries(tx, org, owner, Some(id))
        .await?
        .pop()
        .ok_or_else(not_found)?;
    let lines = load_lines(tx, org, id, None).await?;
    Ok(ChangeSetDetail { summary, lines })
}

impl HrService {
    /// POST `/api/v1/change-sets`: the caller's OPEN draft for the intent,
    /// opened if there is none. Two tabs opening at once share one draft.
    pub async fn open_change_set(
        &self,
        principal: Principal,
        body: OpenChangeSetRequest,
    ) -> Result<ChangeSetDetail, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let intent = normalize_intent(&body.intent)?;
        let (org_id, actor) = (principal.org_id, principal.user_id);
        let org = *org_id.as_uuid();
        let owner = *actor.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org_id, move |tx| {
            Box::pin(async move {
                let opened = sqlx::query(
                    "INSERT INTO change_sets (org_id, intent, created_by) VALUES ($1, $2, $3) \
                     ON CONFLICT (org_id, created_by, intent) WHERE state = 'OPEN' DO NOTHING",
                )
                .bind(org)
                .bind(&intent)
                .bind(owner)
                .execute(tx.as_mut())
                .await?
                .rows_affected()
                    == 1;
                let id: Uuid = sqlx::query_scalar(
                    "SELECT id FROM change_sets \
                     WHERE org_id = $1 AND created_by = $2 AND intent = $3 AND state = 'OPEN'",
                )
                .bind(org)
                .bind(owner)
                .bind(&intent)
                .fetch_one(tx.as_mut())
                .await?;
                let detail = load_detail(tx, org, owner, id).await?;
                // Only a newly opened draft is a write.
                let audits = if opened {
                    let after = json!({ "change_set_id": id, "intent": &intent });
                    vec![draft_audit(
                        org_id,
                        actor,
                        "employee.change_set.open",
                        id,
                        after,
                    )?]
                } else {
                    vec![]
                };
                Ok((detail, audits))
            })
        })
        .await
    }

    /// GET `/api/v1/change-sets`: the caller's OPEN drafts with their counts.
    pub async fn change_sets(
        &self,
        principal: Principal,
    ) -> Result<Vec<ChangeSetSummary>, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let org = *principal.org_id.as_uuid();
        let owner = *principal.user_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move { load_summaries(tx, org, owner, None).await })
        })
        .await
    }

    /// GET `/api/v1/change-sets/{id}`.
    pub async fn change_set(
        &self,
        principal: Principal,
        id: Uuid,
    ) -> Result<ChangeSetDetail, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let org = *principal.org_id.as_uuid();
        let owner = *principal.user_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move { load_detail(tx, org, owner, id).await })
        })
        .await
    }

    /// DELETE `/api/v1/change-sets/{id}`: discard the draft. Repeating it is a
    /// no-op; a committed set stays committed (409).
    pub async fn discard_change_set(&self, principal: Principal, id: Uuid) -> Result<(), HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (org_id, actor) = (principal.org_id, principal.user_id);
        let org = *principal.org_id.as_uuid();
        let owner = *principal.user_id.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                match lock_open_set(tx, org, owner, id).await {
                    Ok(_) => {}
                    Err(error) if error.code == "invalid_transition" => {
                        let discarded: bool = sqlx::query_scalar(
                            "SELECT state = 'DISCARDED' FROM change_sets WHERE org_id = $1 AND id = $2",
                        )
                        .bind(org)
                        .bind(id)
                        .fetch_one(tx.as_mut())
                        .await?;
                        return if discarded { Ok(((), vec![])) } else { Err(error) };
                    }
                    Err(error) => return Err(error),
                }
                sqlx::query(
                    "UPDATE change_sets SET state = 'DISCARDED', closed_at = now() \
                     WHERE org_id = $1 AND id = $2",
                )
                .bind(org)
                .bind(id)
                .execute(tx.as_mut())
                .await?;
                let audit = draft_audit(org_id, actor, "employee.change_set.discard", id, json!({ "change_set_id": id }))?;
                Ok(((), vec![audit]))
            })
        })
        .await
    }
}
