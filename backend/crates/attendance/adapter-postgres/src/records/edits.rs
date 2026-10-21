//! 정정 (A3-correct), 기록 취소 (A3-void) and 일괄 취소 (A3-receipt).

use console_attendance_application::CallerScope;
use console_attendance_application::records::{
    CellInput, CorrectInput, Evidence, UndoInput, VoidInput,
};
use console_attendance_application::records_read::{MarkCounts, SaveReceipt};
use console_kernel_core::OrgId;
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

use super::cells::{Judging, deltas, judge, refusal_of};
use super::entries::{current, one};
use super::roster::load_members;
use super::save::{check_evidence, tally, write_batch};
use crate::PgAttendanceStore;
use crate::schedule::org::load_org;
use crate::schedule::preview::{branch_of, visible};
use crate::schedule::universe::Universe;
use crate::schedule::{
    ScheduleStoreError, audit, claim_key, closed_months, codes, fingerprint, lock_months,
};

fn reason_of(raw: &str) -> Result<String, ScheduleStoreError> {
    let r = raw.trim();
    if r.is_empty() || r.chars().count() > 500 {
        return Err(ScheduleStoreError::Invalid(codes::REASON_REQUIRED));
    }
    Ok(r.to_owned())
}

/// The entry must still be the person-day's current one.
async fn current_entry(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<(Uuid, Date), ScheduleStoreError> {
    let (employee, date, entry) = one(tx, id)
        .await?
        .ok_or(ScheduleStoreError::NotFound(codes::ENTRY_NOT_FOUND))?;
    let now = current(tx, date, date, Some(&[employee])).await?;
    if entry.undone || now.get(&(employee, date)).map(|e| e.id) != Some(id) {
        return Err(ScheduleStoreError::Conflict(codes::ENTRY_SUPERSEDED));
    }
    Ok((employee, date))
}

impl PgAttendanceStore {
    /// 정정 (`value = Some`) or 기록 취소 (`None`) of one current entry.
    async fn amend(
        &self,
        caller: &CallerScope,
        key: &str,
        id: Uuid,
        value: Option<(String, bool)>,
        reason: String,
        evidence: Evidence,
    ) -> Result<(SaveReceipt, bool), ScheduleStoreError> {
        check_evidence(&evidence)?;
        let reason = reason_of(&reason)?;
        let mut intent = json!([id, value.as_ref().map(|v| &v.0), reason, evidence]);
        if value.as_ref().is_some_and(|v| v.1) {
            intent
                .as_array_mut()
                .ok_or(ScheduleStoreError::Corrupt("amend intent"))?
                .push(json!(true));
        }
        let print = fingerprint(&intent);
        let (caller, key) = (caller.clone(), key.to_owned());
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let key = claim_key(tx, &caller, &key).await?;
                let prior: Option<(Uuid, String)> = sqlx::query_as("SELECT id, request_fingerprint FROM attendance_batches WHERE idempotency_key = $1")
                    .bind(&key)
                    .fetch_optional(tx.as_mut())
                    .await?;
                if let Some((batch, f)) = prior {
                    if f != print {
                        return Err(ScheduleStoreError::Conflict(codes::IDEMPOTENCY_KEY_REUSED));
                    }
                    let receipt = SaveReceipt { batch_id: batch, saved: 1, unchanged: 0, closes: MarkCounts::default(), opens: MarkCounts::default() };
                    return Ok(((receipt, false), vec![]));
                }
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7320))").bind(caller.org_id).execute(tx.as_mut()).await?;
                let (employee, date) = current_entry(tx, id).await?;
                let cell = CellInput { employee_id: employee, work_date: date, value: value.as_ref().map(|v| v.0.clone()).unwrap_or_default(), long_span_confirmed: value.as_ref().is_some_and(|v| v.1), base_entry_id: Some(id) };
                let judged = judge(tx, &caller, vec![cell], if value.is_none() { Judging::Void } else { Judging::Save }).await?;
                if let Some(refusal) = refusal_of(&judged) {
                    return Err(refusal);
                }
                let (saved, unchanged) = tally(&judged);
                let (closes, opens) = deltas(&judged);
                let source = if value.is_some() { "CORRECTION" } else { "VOID" };
                let (batch, events) = write_batch(tx, &caller, (key.as_str(), print.as_str()), (source, &evidence), &judged, Some((id, reason.as_str()))).await?;
                Ok(((SaveReceipt { batch_id: batch, saved, unchanged, closes, opens }, true), events))
            })
        })
        .await
    }

    pub async fn correct_entry(
        &self,
        caller: &CallerScope,
        key: &str,
        id: Uuid,
        input: CorrectInput,
    ) -> Result<(SaveReceipt, bool), ScheduleStoreError> {
        self.amend(
            caller,
            key,
            id,
            Some((input.value, input.long_span_confirmed)),
            input.reason,
            input.evidence,
        )
        .await
    }

    pub async fn void_entry(
        &self,
        caller: &CallerScope,
        key: &str,
        id: Uuid,
        input: VoidInput,
    ) -> Result<(SaveReceipt, bool), ScheduleStoreError> {
        self.amend(caller, key, id, None, input.reason, input.evidence)
            .await
    }

    /// 일괄 취소: the whole batch stops counting until its month closes.
    pub async fn undo_batch(
        &self,
        caller: &CallerScope,
        batch: Uuid,
        input: UndoInput,
    ) -> Result<SaveReceipt, ScheduleStoreError> {
        let reason = reason_of(&input.reason)?;
        let caller = caller.clone();
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let row: Option<(bool, i32)> = sqlx::query_as("SELECT undone_at IS NOT NULL, cells FROM attendance_batches WHERE id = $1 FOR UPDATE")
                    .bind(batch)
                    .fetch_optional(tx.as_mut())
                    .await?;
                let (undone, cells) = row.ok_or(ScheduleStoreError::NotFound(codes::BATCH_NOT_FOUND))?;
                if undone {
                    return Err(ScheduleStoreError::Conflict(codes::BATCH_ALREADY_UNDONE));
                }
                let days: Vec<(Uuid, Date)> = sqlx::query_as("SELECT employee_id, work_date FROM attendance_entries WHERE batch_id = $1")
                    .bind(batch)
                    .fetch_all(tx.as_mut())
                    .await?;
                let (first, last) = (days.iter().map(|d| d.1).min(), days.iter().map(|d| d.1).max());
                let (Some(first), Some(last)) = (first, last) else {
                    return Err(ScheduleStoreError::NotFound(codes::BATCH_NOT_FOUND));
                };
                let org = load_org(tx).await?;
                let u = Universe::load(tx, org, (first.year(), last.year())).await?;
                let ids: Vec<Uuid> = days.iter().map(|d| d.0).collect();
                let members = load_members(tx, first, last, Some(&ids)).await?;
                let mut branches = Vec::new();
                for (employee, date) in &days {
                    let p = members.iter().find(|m| m.id == *employee).and_then(|m| m.on(*date));
                    if p.as_ref().is_some_and(|p| !visible(&caller, &u, p)) {
                        return Err(ScheduleStoreError::Forbidden);
                    }
                    branches.push(p.as_ref().and_then(|p| branch_of(&u, p)));
                }
                lock_months(tx, caller.org_id, days.iter().map(|d| d.1)).await?;
                let closed = closed_months(tx, &branches).await?;
                if days.iter().any(|(_, d)| closed.contains(&(d.year(), u8::from(d.month())))) {
                    return Err(ScheduleStoreError::Conflict(codes::BATCH_MONTH_CLOSED));
                }
                sqlx::query("UPDATE attendance_batches SET undone_at = now(), undone_by = $2, undo_reason = $3 WHERE id = $1")
                    .bind(batch)
                    .bind(caller.user_id)
                    .bind(&reason)
                    .execute(tx.as_mut())
                    .await?;
                let event = audit(&caller, "attendance.entries.undo", "attendance_batch", batch, json!({"reason": reason}))?;
                let receipt = SaveReceipt { batch_id: batch, saved: i64::from(cells), unchanged: 0, closes: MarkCounts::default(), opens: MarkCounts::default() };
                Ok((receipt, vec![event]))
            })
        })
        .await
    }
}
