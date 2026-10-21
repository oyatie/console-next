//! Issuing a 발령 공고: the events checked (recorded, not undone, on no other
//! notice), the next 발령 번호 of the notice year taken under the tenant's
//! year lock, the notice and its lines written, one audit row.

use console_hr_domain::text::{
    normalize_limited_text, normalize_optional_limited_text, parse_yyyy_mm_dd,
};
use console_kernel_core::{AuditAction, AuditEvent, KernelError, TraceContext};
use console_platform_authz::{Feature, Principal};
use console_platform_db::idempotency::{
    IdempotencyClaim, claim_idempotency_key, complete_idempotency_key, validate_idempotency_key,
};
use console_platform_db::with_audits;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::read::load_notice;
use super::{IssueAppointmentNoticeRequest, MAX_NOTICE_LINES};
use crate::authz::authorize_hr_org_wide;
use crate::idempotency::idempotency_key_reused;
use crate::lifecycle::title_reason::coded;
use crate::{HrError, HrService};

const OPERATION: &str = "appointment_notice.issue";

fn refused(status: StatusCode, code: &'static str, message: &str, refusals: Value) -> HrError {
    HrError {
        status,
        code,
        message: message.to_owned(),
        refusals: Some(refusals),
    }
}

fn events_required() -> HrError {
    coded(
        KernelError::validation(format!(
            "name 1 to {MAX_NOTICE_LINES} events with exactly one of event_ids or batch_id"
        ))
        .with_code("appointment_notice_events_required"),
    )
}

/// The events to announce, in printed order.
async fn named_events(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    body: &IssueAppointmentNoticeRequest,
) -> Result<Vec<Uuid>, HrError> {
    let ids = match (body.event_ids.is_empty(), body.batch_id) {
        (false, None) => body.event_ids.clone(),
        (true, Some(batch)) => {
            sqlx::query_scalar(
                "SELECT id FROM employee_lifecycle_events WHERE org_id = $1 AND batch_id = $2 \
             AND event_type <> 'RESCIND' ORDER BY employee_id, id",
            )
            .bind(org)
            .bind(batch)
            .fetch_all(tx.as_mut())
            .await?
        }
        _ => return Err(events_required()),
    };
    let distinct: std::collections::BTreeSet<&Uuid> = ids.iter().collect();
    if ids.is_empty() && body.batch_id.is_some() {
        return Err(HrError::from_kernel(KernelError::not_found(
            "batch not found",
        )));
    }
    if ids.is_empty() || ids.len() > MAX_NOTICE_LINES || distinct.len() != ids.len() {
        return Err(events_required());
    }
    Ok(ids)
}

/// Every event exists, is recorded (APPLIED or SCHEDULED), is a 발령 (not a
/// RESCIND or an exit reversal), is not undone, and is on no other notice.
async fn check_events(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    ids: &[Uuid],
) -> Result<(), HrError> {
    let rows: Vec<(Uuid, String, String, bool, Option<String>)> = sqlx::query_as(
        "SELECT l.id, l.state, l.event_type, \
                EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.voids_event_id = l.id), \
                (SELECT n.notice_no FROM appointment_notice_lines x \
                   JOIN appointment_notices n ON n.org_id = x.org_id AND n.id = x.notice_id \
                  WHERE x.org_id = l.org_id AND x.lifecycle_event_id = l.id) \
           FROM employee_lifecycle_events l \
          WHERE l.org_id = $1 AND l.id = ANY($2) ORDER BY l.id FOR SHARE OF l",
    )
    .bind(org)
    .bind(ids)
    .fetch_all(tx.as_mut())
    .await?;
    if rows.len() != ids.len() {
        let found: Vec<Uuid> = rows.iter().map(|r| r.0).collect();
        let missing: Vec<&Uuid> = ids.iter().filter(|id| !found.contains(id)).collect();
        return Err(refused(
            StatusCode::NOT_FOUND,
            "not_found",
            "a named lifecycle event does not exist",
            json!(
                missing
                    .iter()
                    .map(|id| json!({"lifecycle_event_id": id}))
                    .collect::<Vec<_>>()
            ),
        ));
    }
    let taken: Vec<Value> = rows
        .iter()
        .filter_map(|(id, _, _, _, no)| {
            no.as_ref()
                .map(|no| json!({"lifecycle_event_id": id, "notice_no": no}))
        })
        .collect();
    if !taken.is_empty() {
        return Err(refused(
            StatusCode::CONFLICT,
            "appointment_notice_event_taken",
            "an event is already on another notice",
            json!(taken),
        ));
    }
    let ineligible: Vec<Value> = rows
        .iter()
        .filter(|(_, state, kind, voided, _)| {
            !matches!(state.as_str(), "APPLIED" | "SCHEDULED")
                || matches!(kind.as_str(), "RESCIND" | "EXIT_REVERSAL")
                || *voided
        })
        .map(|(id, state, kind, voided, _)| {
            json!({"lifecycle_event_id": id, "state": state, "event_type": kind, "voided": voided})
        })
        .collect();
    if !ineligible.is_empty() {
        return Err(refused(
            StatusCode::CONFLICT,
            "appointment_notice_event_ineligible",
            "only a recorded 발령 that was not undone can be announced",
            json!(ineligible),
        ));
    }
    Ok(())
}

/// The next sequence of the notice year, under the tenant's year lock.
async fn next_seq(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    year: i32,
) -> Result<i32, HrError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1::text || ':appointment_notice:' || $2))")
        .bind(org)
        .bind(year)
        .execute(tx.as_mut())
        .await?;
    let seq: i32 = sqlx::query_scalar(
        "SELECT COALESCE(max(seq), 0) + 1 FROM appointment_notices WHERE org_id = $1 AND notice_year = $2",
    )
    .bind(org)
    .bind(year)
    .fetch_one(tx.as_mut())
    .await?;
    if seq > 9999 {
        return Err(coded(
            KernelError::conflict("the notice year has no 발령 번호 left")
                .with_code("appointment_notice_numbers_exhausted"),
        ));
    }
    Ok(seq)
}

impl HrService {
    /// `POST /api/v1/appointment-notices` (Idempotency-Key required).
    pub async fn issue_appointment_notice(
        &self,
        principal: Principal,
        idempotency_key: Option<String>,
        body: IssueAppointmentNoticeRequest,
    ) -> Result<Value, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let key =
            validate_idempotency_key(idempotency_key.as_deref()).map_err(HrError::validation)?;
        let fingerprint = json!(&body);
        let title = normalize_limited_text(body.title.clone(), 200, "title")?;
        let note = normalize_optional_limited_text(body.note.clone(), 1000, "note")?;
        let date = parse_yyyy_mm_dd(&body.notice_date)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                match claim_idempotency_key(tx, OPERATION, &key, &fingerprint).await? {
                    IdempotencyClaim::Replay(response) => return Ok((response, vec![])),
                    IdempotencyClaim::Mismatch => return Err(idempotency_key_reused()),
                    IdempotencyClaim::Fresh => {}
                }
                let ids = named_events(tx, org_uuid, &body).await?;
                check_events(tx, org_uuid, &ids).await?;
                let year = date.year();
                let seq = next_seq(tx, org_uuid, year).await?;
                let notice_no = format!("{year}-{seq:04}");
                let id: Uuid = sqlx::query_scalar(
                    "INSERT INTO appointment_notices \
                     (org_id, notice_year, seq, notice_no, title, notice_date, note, issued_by) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
                )
                .bind(org_uuid)
                .bind(year)
                .bind(seq)
                .bind(&notice_no)
                .bind(&title)
                .bind(date)
                .bind(&note)
                .bind(*actor.as_uuid())
                .fetch_one(tx.as_mut())
                .await?;
                sqlx::query(
                    "INSERT INTO appointment_notice_lines (org_id, notice_id, lifecycle_event_id, line_no) \
                     SELECT $1, $2, e.id, e.n::INTEGER FROM unnest($3::UUID[]) WITH ORDINALITY AS e(id, n)",
                )
                .bind(org_uuid)
                .bind(id)
                .bind(&ids)
                .execute(tx.as_mut())
                .await
                .map_err(|error| match &error {
                    // A concurrent notice took an event after the check.
                    sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => refused(
                        StatusCode::CONFLICT,
                        "appointment_notice_event_taken",
                        "an event is already on another notice",
                        json!([]),
                    ),
                    _ => HrError::from(error),
                })?;
                let notice = load_notice(tx, org_uuid, id, true).await?;
                let audit = AuditEvent::new(
                    Some(actor),
                    AuditAction::new(OPERATION).map_err(HrError::from_kernel)?,
                    "appointment_notice",
                    id.to_string(),
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )
                .with_org(org)
                .with_snapshots(
                    None,
                    Some(json!({"notice_no": notice_no, "lifecycle_event_ids": &ids,
                                "notice_date": date.to_string()})),
                );
                let response = serde_json::to_value(&notice)
                    .map_err(|_| HrError::internal("response serialization failed"))?;
                complete_idempotency_key(tx, OPERATION, &key, &response).await?;
                Ok((response, vec![audit]))
            })
        })
        .await
    }
}
