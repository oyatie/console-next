//! Schedule layers: preview, assign, cancel before effect, history.

use console_attendance_application::CallerScope;
use console_attendance_application::schedule::{
    AssignInput, AssignReceipt, Items, LayerRead, ReasonInput, SchedulePreview, layer_state,
};
use console_attendance_domain::schedule::{Level, PatternSpec, ScheduleRefusal, check_cancel};
use console_kernel_core::OrgId;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

use super::org::{load_org, load_roster};
use super::preview::{authorize_scope, branch_of, preview, reach};
use super::universe::{Universe, today_kst};
use super::{
    ScheduleStoreError, audit, claim_key, closed_months, codes, fingerprint, lock_closed_months,
};
use crate::PgAttendanceStore;

const READ_SQL: &str = "SELECT l.id, l.scope_kind, COALESCE(l.legal_entity_id, l.workplace_id, l.org_unit_id, l.crew_id, l.employee_id) AS scope_id, \
     l.pattern_id, p.name AS pattern_name, l.effective_from, l.effective_to, l.rotation_start, l.start_choice, l.reason, \
     l.evidence_ref, l.version, l.status, l.cancel_reason, l.created_at, COALESCE(cu.display_name, '') AS created_by_name, \
     l.cancelled_at, xu.display_name AS cancelled_by_name, e.name AS person_name, \
     (SELECT min(n.effective_from) FROM attendance_schedule_layers n WHERE n.status = 'ACTIVE' AND n.effective_to IS NULL \
        AND n.scope_kind = l.scope_kind AND n.effective_from > l.effective_from \
        AND COALESCE(n.legal_entity_id, n.workplace_id, n.org_unit_id, n.crew_id, n.employee_id) \
          = COALESCE(l.legal_entity_id, l.workplace_id, l.org_unit_id, l.crew_id, l.employee_id)) AS next_from \
     FROM attendance_schedule_layers l JOIN attendance_work_patterns p ON p.id = l.pattern_id AND p.org_id = l.org_id \
     LEFT JOIN users cu ON cu.id = l.created_by AND cu.org_id = l.org_id \
     LEFT JOIN users xu ON xu.id = l.cancelled_by AND xu.org_id = l.org_id \
     LEFT JOIN employees e ON e.id = l.employee_id AND e.org_id = l.org_id";

pub(crate) fn scope_name(u: &Universe, level: Level, id: Uuid, person: Option<String>) -> String {
    match level {
        Level::LegalEntity => u.org.entities.get(&id).cloned(),
        Level::Workplace => u.org.workplaces.get(&id).map(|w| w.name.clone()),
        Level::Department => u.org.units.get(&id).map(|x| x.name.clone()),
        Level::Crew => u.org.crews.get(&id).map(|(_, n)| n.clone()),
        Level::Person => person,
    }
    .unwrap_or_default()
}

async fn reads(
    tx: &mut Transaction<'_, Postgres>,
    u: &Universe,
    filter: &str,
    bind: Uuid,
    text: Option<&str>,
) -> Result<Vec<LayerRead>, ScheduleStoreError> {
    let today = today_kst();
    let sql = format!("{READ_SQL} WHERE {filter} ORDER BY l.effective_from DESC, l.version DESC");
    let rows = sqlx::query(sqlx::AssertSqlSafe(&*sql))
        .bind(bind)
        .bind(text)
        .fetch_all(tx.as_mut())
        .await?;
    rows.iter()
        .map(|r| {
            let kind: String = r.try_get("scope_kind")?;
            let level = Level::parse(&kind).ok_or(ScheduleStoreError::Corrupt("scope_kind"))?;
            let scope_id: Uuid = r.try_get("scope_id")?;
            let status: String = r.try_get("status")?;
            let from = r.try_get("effective_from")?;
            let to = r.try_get("effective_to")?;
            Ok(LayerRead {
                id: r.try_get("id")?,
                scope_kind: level,
                scope_id,
                scope_name: scope_name(u, level, scope_id, r.try_get("person_name")?),
                pattern_id: r.try_get("pattern_id")?,
                pattern_name: r.try_get("pattern_name")?,
                effective_from: from,
                effective_to: to,
                rotation_start: r.try_get("rotation_start")?,
                start_choice: r.try_get("start_choice")?,
                reason: r.try_get("reason")?,
                evidence_ref: r.try_get("evidence_ref")?,
                version: r.try_get("version")?,
                state: layer_state(
                    status == "CANCELLED",
                    from,
                    to,
                    r.try_get("next_from")?,
                    today,
                ),
                cancel_reason: r.try_get("cancel_reason")?,
                created_at: r.try_get("created_at")?,
                created_by_name: r.try_get("created_by_name")?,
                cancelled_at: r.try_get("cancelled_at")?,
                cancelled_by_name: r.try_get("cancelled_by_name")?,
            })
        })
        .collect()
}

/// The refusal behind a preview code, so a commit answers 409 or 422 alike.
fn refusal(code: &str) -> ScheduleStoreError {
    [
        ScheduleRefusal::EffectiveRangeInvalid,
        ScheduleRefusal::PatternRetired,
        ScheduleRefusal::EvidenceRequired,
        ScheduleRefusal::SubstituteNeedsEnd,
        ScheduleRefusal::StartChoiceInvalid,
        ScheduleRefusal::MonthClosed,
    ]
    .into_iter()
    .find(|r| r.code() == code)
    .map_or(
        ScheduleStoreError::Corrupt("refusal"),
        ScheduleStoreError::Refused,
    )
}

async fn plan(
    tx: &mut Transaction<'_, Postgres>,
    caller: &CallerScope,
    input: &AssignInput,
) -> Result<(Universe, SchedulePreview), ScheduleStoreError> {
    if input.targets.is_empty() || input.targets.len() > 20 {
        return Err(ScheduleStoreError::Invalid(codes::TARGETS_INVALID));
    }
    let year = input.effective_from.year();
    let org = load_org(tx).await?;
    let u = Universe::load(tx, org, (year, year)).await?;
    let roster = load_roster(tx, input.effective_from, None).await?;
    let mut branches = Vec::new();
    for t in &input.targets {
        branches.push(authorize_scope(
            caller,
            &u,
            &roster,
            t.scope_kind,
            t.scope_id,
        )?);
    }
    // A 법인 target reaches the branches of the people it reaches.
    let reached = roster.iter().filter(|p| {
        input
            .targets
            .iter()
            .any(|t| reach(&u, p, t.scope_kind, t.scope_id).is_some())
    });
    branches.extend(reached.map(|p| branch_of(&u, p)));
    let closed = closed_months(tx, &branches).await?;
    let p = preview(caller, &u, &roster, input, today_kst(), &closed)?;
    Ok((u, p))
}

impl PgAttendanceStore {
    pub async fn preview_schedule(
        &self,
        caller: &CallerScope,
        input: AssignInput,
    ) -> Result<SchedulePreview, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| Box::pin(async move { Ok(plan(tx, &caller, &input).await?.1) }),
        )
        .await
    }

    pub async fn assign_schedule(
        &self,
        caller: &CallerScope,
        key: &str,
        input: AssignInput,
    ) -> Result<(AssignReceipt, bool), ScheduleStoreError> {
        let targets: Vec<_> = input
            .targets
            .iter()
            .map(|t| {
                json!([
                    t.scope_kind,
                    t.scope_id,
                    t.rotation_start.map(|d| d.to_string()),
                    t.start_choice
                ])
            })
            .collect();
        let print = fingerprint(&json!([
            targets,
            input.pattern_id,
            input.effective_from.to_string(),
            input.effective_to.map(|d| d.to_string()),
            input.reason,
            input.evidence_ref
        ]));
        let (caller, key) = (caller.clone(), key.to_owned());
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let key = claim_key(tx, &caller, &key).await?;
                let prior: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, request_fingerprint FROM attendance_schedule_layers WHERE idempotency_key = $1")
                    .bind(&key).fetch_all(tx.as_mut()).await?;
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7319))").bind(caller.org_id).execute(tx.as_mut()).await?;
                lock_closed_months(tx, caller.org_id).await?;
                let (u, preview) = plan(tx, &caller, &input).await?;
                if let Some((_, f)) = prior.first() {
                    if *f != print {
                        return Err(ScheduleStoreError::Conflict(codes::IDEMPOTENCY_KEY_REUSED));
                    }
                    let layers = reads(tx, &u, "l.idempotency_key = $2 AND $1::uuid IS NOT NULL", Uuid::nil(), Some(&key)).await?;
                    return Ok(((AssignReceipt { layers, people_changed: preview.people_changed }, false), vec![]));
                }
                if let Some(r) = preview.refusals.first() {
                    return Err(refusal(r.code));
                }
                let rotation = matches!(u.patterns.get(&input.pattern_id).map(|p| &p.spec.pattern), Some(PatternSpec::Rotation { .. }));
                let mut events = Vec::new();
                for t in &input.targets {
                    let id = Uuid::new_v4();
                    let col = match t.scope_kind {
                        Level::LegalEntity => "legal_entity_id",
                        Level::Workplace => "workplace_id",
                        Level::Department => "org_unit_id",
                        Level::Crew => "crew_id",
                        Level::Person => "employee_id",
                    };
                    let sql = format!(
                        "INSERT INTO attendance_schedule_layers (id, org_id, scope_kind, {col}, pattern_id, effective_from, effective_to, \
                         rotation_start, start_choice, reason, evidence_ref, version, created_by, idempotency_key, request_fingerprint) \
                         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE(max(version), 0) + 1, $12, $13, $14 \
                         FROM attendance_schedule_layers WHERE scope_kind = $3 AND {col} = $4"
                    );
                    sqlx::query(sqlx::AssertSqlSafe(&*sql))
                        .bind(id).bind(caller.org_id).bind(t.scope_kind.as_str()).bind(t.scope_id).bind(input.pattern_id)
                        .bind(input.effective_from).bind(input.effective_to)
                        .bind(t.rotation_start.or(rotation.then_some(input.effective_from)))
                        .bind(t.start_choice.and_then(|c| i16::try_from(c).ok()))
                        .bind(&input.reason).bind(input.evidence_ref.as_deref().map(str::trim).filter(|e| !e.is_empty()))
                        .bind(caller.user_id).bind(&key).bind(&print)
                        .execute(tx.as_mut()).await?;
                    events.push(audit(&caller, "attendance.schedule.assign", "attendance_schedule_layer", id,
                        json!({"scope_kind": t.scope_kind, "scope_id": t.scope_id, "pattern_id": input.pattern_id, "effective_from": input.effective_from.to_string()}))?);
                }
                let layers = reads(tx, &u, "l.idempotency_key = $2 AND $1::uuid IS NOT NULL", Uuid::nil(), Some(&key)).await?;
                Ok(((AssignReceipt { layers, people_changed: preview.people_changed }, true), events))
            })
        })
        .await
    }

    pub async fn cancel_layer(
        &self,
        caller: &CallerScope,
        id: Uuid,
        input: ReasonInput,
    ) -> Result<LayerRead, ScheduleStoreError> {
        let reason = input.reason.trim().to_owned();
        if reason.is_empty() || reason.chars().count() > 500 {
            return Err(ScheduleStoreError::Invalid(codes::REASON_REQUIRED));
        }
        let caller = caller.clone();
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let row = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {}, status FROM attendance_schedule_layers WHERE id = $1 FOR UPDATE", super::universe::LAYER_COLUMNS)))
                    .bind(id).fetch_optional(tx.as_mut()).await?.ok_or(ScheduleStoreError::NotFound(codes::LAYER_NOT_FOUND))?;
                let layer = super::universe::layer_from_row(&row)?;
                let org = load_org(tx).await?;
                let u = Universe::load(tx, org, (layer.from.year(), layer.from.year())).await?;
                let roster = load_roster(tx, today_kst(), (layer.level == Level::Person).then_some(layer.scope_id)).await?;
                authorize_scope(&caller, &u, &roster, layer.level, layer.scope_id)?;
                let status: String = row.try_get("status")?;
                if status != "ACTIVE" {
                    return Err(ScheduleStoreError::Conflict(codes::LAYER_ALREADY_CANCELLED));
                }
                check_cancel(today_kst(), layer.from)?;
                sqlx::query("UPDATE attendance_schedule_layers SET status = 'CANCELLED', cancel_reason = $2, cancelled_by = $3, cancelled_at = now() WHERE id = $1")
                    .bind(id).bind(&reason).bind(caller.user_id).execute(tx.as_mut()).await?;
                let event = audit(&caller, "attendance.schedule.cancel", "attendance_schedule_layer", id, json!({"reason": reason}))?;
                let read = reads(tx, &u, "l.id = $1 AND $2::text IS NULL", id, None).await?.pop().ok_or(ScheduleStoreError::NotFound(codes::LAYER_NOT_FOUND))?;
                Ok((read, vec![event]))
            })
        })
        .await
    }

    pub async fn list_layers(
        &self,
        caller: &CallerScope,
        level: Level,
        scope_id: Uuid,
    ) -> Result<Items<LayerRead>, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let today = today_kst();
                let org = load_org(tx).await?;
                let u = Universe::load(tx, org, (today.year(), today.year())).await?;
                let roster = load_roster(tx, today, (level == Level::Person).then_some(scope_id)).await?;
                authorize_scope(&caller, &u, &roster, level, scope_id)?;
                let items = reads(tx, &u, "l.scope_kind = $2 AND COALESCE(l.legal_entity_id, l.workplace_id, l.org_unit_id, l.crew_id, l.employee_id) = $1", scope_id, Some(level.as_str())).await?;
                Ok(Items { items })
            })
        })
        .await
    }
}
