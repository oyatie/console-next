//! Preview and save: one batch, one transaction, at most 10,000 cells. A
//! refused cell or a changed base saves nothing (A3-save, A12-conflict).

use console_attendance_application::CallerScope;
use console_attendance_application::records::{
    CellInput, Evidence, MAX_CELLS, PreviewInput, SaveInput,
};
use console_attendance_application::records_read::{SavePreview, SaveReceipt};
use console_kernel_core::{AuditEvent, OrgId};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::cells::{Judged, Judging, Outcome, deltas, judge, refusal_of};
use crate::PgAttendanceStore;
use crate::schedule::{ScheduleStoreError, audit, claim_key, codes, fingerprint};

fn sized(cells: &[CellInput]) -> Result<(), ScheduleStoreError> {
    match cells.len() {
        0 => Err(ScheduleStoreError::Invalid(codes::NOTHING_TO_SAVE)),
        n if n > MAX_CELLS => Err(ScheduleStoreError::Invalid(codes::BATCH_TOO_LARGE)),
        _ => Ok(()),
    }
}

pub(crate) fn check_evidence(e: &Evidence) -> Result<(), ScheduleStoreError> {
    use console_attendance_application::records::EvidenceKind;
    if e.kind == EvidenceKind::SupervisorConfirm && e.confirmer_employee_id.is_none() {
        return Err(ScheduleStoreError::Invalid(
            codes::EVIDENCE_CONFIRMER_REQUIRED,
        ));
    }
    Ok(())
}

pub(crate) fn tally(judged: &[Judged]) -> (i64, i64) {
    let ok = judged
        .iter()
        .filter(|j| matches!(j.outcome, Outcome::Write(..)))
        .count();
    let same = judged
        .iter()
        .filter(|j| matches!(j.outcome, Outcome::Unchanged))
        .count();
    (
        i64::try_from(ok).unwrap_or(i64::MAX),
        i64::try_from(same).unwrap_or(i64::MAX),
    )
}

/// Writes one batch with the judged cells that change something.
pub(crate) async fn write_batch(
    tx: &mut Transaction<'_, Postgres>,
    caller: &CallerScope,
    (key, print): (&str, &str),
    (source, evidence): (&str, &Evidence),
    judged: &[Judged],
    supersede: Option<(Uuid, &str)>,
) -> Result<(Uuid, Vec<AuditEvent>), ScheduleStoreError> {
    let writes: Vec<_> = judged
        .iter()
        .filter_map(|j| match &j.outcome {
            Outcome::Write(kind, segments) => Some((j, *kind, segments)),
            _ => None,
        })
        .collect();
    if writes.is_empty() {
        return Err(ScheduleStoreError::Invalid(codes::NOTHING_TO_SAVE));
    }
    let batch = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO attendance_batches (id, org_id, source, evidence_kind, evidence_note, confirmer_employee_id, cells, \
         created_by, idempotency_key, request_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(batch)
    .bind(caller.org_id)
    .bind(source)
    .bind(evidence.kind.as_str())
    .bind(evidence.note.as_deref().map(str::trim).filter(|n| !n.is_empty()))
    .bind(evidence.confirmer_employee_id)
    .bind(i32::try_from(writes.len()).unwrap_or(i32::MAX))
    .bind(caller.user_id)
    .bind(key)
    .bind(print)
    .execute(tx.as_mut())
    .await?;
    for (j, kind, segments) in &writes {
        let segments =
            serde_json::to_value(segments).map_err(|_| ScheduleStoreError::Corrupt("segments"))?;
        sqlx::query(
            "INSERT INTO attendance_entries (org_id, batch_id, employee_id, work_date, kind, segments, supersedes_id, reason, created_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(caller.org_id)
        .bind(batch)
        .bind(j.cell.employee_id)
        .bind(j.cell.work_date)
        .bind(kind.as_str())
        .bind(segments)
        .bind(supersede.map(|s| s.0).or(j.cell.base_entry_id))
        .bind(supersede.map(|s| s.1))
        .bind(caller.user_id)
        .execute(tx.as_mut())
        .await?;
    }
    let action = match source {
        "CORRECTION" => "attendance.entry.correct",
        "VOID" => "attendance.entry.void",
        _ => "attendance.entries.save",
    };
    let target = if supersede.is_some() {
        "attendance_entry"
    } else {
        "attendance_batch"
    };
    let id = supersede.map_or(batch, |s| s.0);
    let event = audit(
        caller,
        action,
        target,
        id,
        json!({"batch_id": batch, "cells": writes.len(), "long_span_confirmations": writes.iter().filter(|(j, _, _)| j.cell.long_span_confirmed).map(|(j, _, _)| json!({"employee_id": j.cell.employee_id, "work_date": j.cell.work_date.to_string(), "threshold_minutes": j.preview.long_span_minutes})).collect::<Vec<_>>()}),
    )?;
    Ok((batch, vec![event]))
}

impl PgAttendanceStore {
    pub async fn preview_entries(
        &self,
        caller: &CallerScope,
        input: PreviewInput,
    ) -> Result<SavePreview, ScheduleStoreError> {
        sized(&input.cells)?;
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let judged = judge(tx, &caller, input.cells, Judging::Preview).await?;
                    let (ok, unchanged) = tally(&judged);
                    let (closes, opens) = deltas(&judged);
                    let refused = judged
                        .iter()
                        .filter(|j| matches!(j.outcome, Outcome::Refused(_)))
                        .count();
                    let conflicts = judged
                        .iter()
                        .filter(|j| matches!(j.outcome, Outcome::Conflict(_)))
                        .count();
                    Ok(SavePreview {
                        cells: judged.into_iter().map(|j| j.preview).collect(),
                        ok,
                        unchanged,
                        refused: i64::try_from(refused).unwrap_or(i64::MAX),
                        conflicts: i64::try_from(conflicts).unwrap_or(i64::MAX),
                        closes,
                        opens,
                    })
                })
            },
        )
        .await
    }

    pub async fn save_entries(
        &self,
        caller: &CallerScope,
        key: &str,
        input: SaveInput,
    ) -> Result<(SaveReceipt, bool), ScheduleStoreError> {
        sized(&input.cells)?;
        check_evidence(&input.evidence)?;
        let print = fingerprint(&json!([input.cells, input.source, input.evidence]));
        let (caller, key) = (caller.clone(), key.to_owned());
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let key = claim_key(tx, &caller, &key).await?;
                let prior: Option<(Uuid, String, i32)> = sqlx::query_as("SELECT id, request_fingerprint, cells FROM attendance_batches WHERE idempotency_key = $1")
                    .bind(&key)
                    .fetch_optional(tx.as_mut())
                    .await?;
                if let Some((batch, f, cells)) = prior {
                    if f != print {
                        return Err(ScheduleStoreError::Conflict(codes::IDEMPOTENCY_KEY_REUSED));
                    }
                    let receipt = SaveReceipt { batch_id: batch, saved: i64::from(cells), unchanged: 0, closes: Default::default(), opens: Default::default() };
                    return Ok(((receipt, false), vec![]));
                }
                // one tenant-wide lock serialises saves so the If-Match
                // check and the insert see the same state; per person-month
                // advisory locks if two HR workers ever queue behind each other.
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7320))").bind(caller.org_id).execute(tx.as_mut()).await?;
                let judged = judge(tx, &caller, input.cells, Judging::Save).await?;
                if let Some(refusal) = refusal_of(&judged) {
                    return Err(refusal);
                }
                let (saved, unchanged) = tally(&judged);
                let (closes, opens) = deltas(&judged);
                let (batch, events) = write_batch(tx, &caller, (key.as_str(), print.as_str()), (input.source.as_str(), &input.evidence), &judged, None).await?;
                Ok(((SaveReceipt { batch_id: batch, saved, unchanged, closes, opens }, true), events))
            })
        })
        .await
    }
}
