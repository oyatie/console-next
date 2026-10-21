//! The daily clock tick (lifecycle-events.md §5.6): a 시행일-style schedule in
//! the worker role (#27 allows it), not a client refresh loop.
//!
//! Once per tenant per KST day — the first replica to insert the day's
//! `lifecycle_case_clock_runs` row wins; the others find it and do nothing —
//! the tick:
//! 1. settles the due date of every open template item not yet computed
//!    (`due_basis = '{}'`), still waiting for its anchor, or unresolved, through
//!    `case_clocks` over the statutory register;
//! 2. finds the open cases with an item that became overdue, or entered the
//!    7-day window, since the last run;
//! 3. writes one `lifecycle_case.clock_tick` audit row per such case (system
//!    actor). BE-RT's audit trigger turns it into the change rows that make
//!    open shells invalidate once.

use std::collections::{BTreeMap, BTreeSet};

use console_compliance_domain::statutory::StatutoryRegister;
use console_hr_domain::cases::clocks::{Anchor, Anchors, Clock, DueRule, case_clocks};
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_db::with_audits;
use serde_json::{Value, json};
use sqlx::Row;
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

use super::register::Register;
use crate::{HrError, HrService};

/// Items whose due date entered the Home window (「이번 주」, §7) count as changed.
/// the window is the UI's 7 days; read it from the summary API's
/// setting if that ever becomes tenant policy.
const DUE_SOON_DAYS: i64 = 7;

impl HrService {
    /// Runs today's clock tick in every tenant. Returns how many cases changed.
    /// One tenant's fault never stops the others; the first fault is returned
    /// after all tenants ran, so the caller retries the day.
    ///
    /// # Errors
    /// The tenant list could not be read, or a tenant's tick failed.
    pub async fn run_case_clock_tick(
        &self,
        today: Date,
        register: &StatutoryRegister,
    ) -> Result<usize, String> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_audits
            .fetch_all(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        let mut changed = 0;
        let mut first_fault = None;
        for org in orgs {
            match self
                .case_clock_tick(OrgId::from_uuid(org), today, register.clone())
                .await
            {
                Ok(cases) => changed += cases,
                Err(error) => {
                    tracing::warn!(%org, error = %error.message, "lifecycle case clock tick failed; retrying");
                    first_fault.get_or_insert(error.message);
                }
            }
        }
        first_fault.map_or(Ok(changed), Err)
    }

    /// One tenant's tick for `today`. `Ok(0)` when another run already claimed it.
    ///
    /// # Errors
    /// A database fault (the whole tick rolls back, the claim with it).
    pub async fn case_clock_tick(
        &self,
        org: OrgId,
        today: Date,
        register: StatutoryRegister,
    ) -> Result<usize, HrError> {
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let claimed: Option<Date> = sqlx::query_scalar(
                    "INSERT INTO lifecycle_case_clock_runs (org_id, run_date) VALUES ($1, $2) \
                     ON CONFLICT DO NOTHING RETURNING run_date",
                )
                .bind(org_uuid)
                .bind(today)
                .fetch_optional(tx.as_mut())
                .await?;
                if claimed.is_none() {
                    return Ok((0, Vec::new()));
                }
                let since: Date = sqlx::query_scalar(
                    "SELECT max(run_date) FROM lifecycle_case_clock_runs WHERE org_id = $1 AND run_date < $2",
                )
                .bind(org_uuid)
                .bind(today)
                .fetch_one(tx.as_mut())
                .await
                .map(|last: Option<Date>| last.unwrap_or(today - Duration::days(1)))?;

                let register = Register(register);
                let mut touched: BTreeSet<Uuid> = BTreeSet::new();
                let rows = sqlx::query(
                    "SELECT i.id, i.case_id, i.requested_on, i.due_basis, k.kind, k.effective_date, \
                            t.release_disposition, ti.due_anchor, ti.due_rule_kind, ti.due_register_code \
                     FROM lifecycle_case_items i \
                     JOIN lifecycle_cases k ON k.org_id = i.org_id AND k.id = i.case_id \
                     JOIN case_templates t ON t.template_key = k.template_key AND t.version = i.template_item_version \
                     JOIN case_template_items ti ON ti.template_key = t.template_key \
                      AND ti.version = t.version AND ti.item_key = i.item_key \
                     WHERE i.org_id = $1 AND k.state = 'OPEN' AND i.source = 'TEMPLATE' \
                       AND i.status IN ('PENDING_TRIGGER', 'OPEN', 'BLOCKED') \
                       AND (i.due_basis = '{}'::jsonb OR i.due_basis ? 'awaiting_anchor' OR i.due_basis ? 'unresolved') \
                     ORDER BY i.case_id, i.item_key FOR UPDATE OF i",
                )
                .bind(org_uuid)
                .fetch_all(tx.as_mut())
                .await?;
                for row in rows {
                    let rule = DueRule::parse(
                        row.try_get::<Option<String>, _>("due_anchor")?.as_deref(),
                        &row.try_get::<String, _>("due_rule_kind")?,
                        row.try_get::<Option<String>, _>("due_register_code")?.as_deref(),
                    )?;
                    let effective: Date = row.try_get("effective_date")?;
                    let mut anchors = BTreeMap::from([(Anchor::EffectiveDate, effective)]);
                    if row.try_get::<String, _>("kind")? == "EXIT" {
                        anchors.insert(Anchor::ExitDate, effective);
                        if let Some(next) = effective.next_day() {
                            anchors.insert(Anchor::LossDate, next);
                        }
                    }
                    if let Some(requested) = row.try_get::<Option<Date>, _>("requested_on")? {
                        anchors.insert(Anchor::RequestDate, requested);
                    }
                    let clock = case_clocks(std::slice::from_ref(&rule), &Anchors(anchors), &register)
                        .pop()
                        .unwrap_or(Clock::Unknown);
                    let template_hold = row.try_get::<String, _>("release_disposition")? != "RELEASED";
                    let (due, disposition, basis) = settle(&rule, clock, template_hold, today);
                    if basis == row.try_get::<Value, _>("due_basis")? {
                        continue;
                    }
                    sqlx::query(
                        "UPDATE lifecycle_case_items SET due_date = $3, due_disposition = $4, due_basis = $5, \
                                version = version + 1 \
                         WHERE org_id = $1 AND id = $2",
                    )
                    .bind(org_uuid)
                    .bind(row.try_get::<Uuid, _>("id")?)
                    .bind(due)
                    .bind(disposition)
                    .bind(&basis)
                    .execute(tx.as_mut())
                    .await?;
                    touched.insert(row.try_get("case_id")?);
                }

                let crossed: Vec<Uuid> = sqlx::query_scalar(
                    "SELECT DISTINCT i.case_id FROM lifecycle_case_items i \
                     JOIN lifecycle_cases k ON k.org_id = i.org_id AND k.id = i.case_id \
                     WHERE i.org_id = $1 AND k.state = 'OPEN' \
                       AND i.status IN ('PENDING_TRIGGER', 'OPEN', 'BLOCKED') \
                       AND ((i.due_date >= $2 AND i.due_date < $3) \
                            OR (i.due_date > $2 + $4::int AND i.due_date <= $3 + $4::int))",
                )
                .bind(org_uuid)
                .bind(since)
                .bind(today)
                .bind(i32::try_from(DUE_SOON_DAYS).unwrap_or(7))
                .fetch_all(tx.as_mut())
                .await?;
                touched.extend(crossed);

                let action = AuditAction::new("lifecycle_case.clock_tick").map_err(HrError::from_kernel)?;
                let mut events: Vec<AuditEvent> = touched
                    .iter()
                    .map(|case_id| {
                        AuditEvent::new(
                            None,
                            action.clone(),
                            "lifecycle_case",
                            case_id.to_string(),
                            TraceContext::generate(),
                            OffsetDateTime::now_utc(),
                        )
                        .with_org(org)
                        .with_snapshots(None, Some(json!({ "run_date": today.to_string(), "since": since.to_string() })))
                    })
                    .collect();
                events.push(AuditEvent::new(None, AuditAction::new("insurance_filing.clock_tick")?, "insurance_filing", "clock", TraceContext::generate(), OffsetDateTime::now_utc()).with_org(org)
                    .with_snapshots(None, Some(json!({"run_date": today.to_string()}))));
                Ok((touched.len(), events))
            })
        })
        .await
    }
}

/// The item's stored due date, disposition and basis for a clock.
fn settle(
    rule: &DueRule,
    clock: Clock,
    template_hold: bool,
    today: Date,
) -> (Option<Date>, &'static str, Value) {
    let hold = |held: bool| {
        if held || template_hold {
            "HOLD"
        } else {
            "RELEASED"
        }
    };
    let anchor = rule.anchor.map(|a| a.as_str());
    let code = rule.register_code.as_deref();
    match clock {
        Clock::Due { date, held } => (
            Some(date),
            hold(held),
            json!({ "anchor": anchor, "register_code": code, "computed_on": today.to_string() }),
        ),
        Clock::WithoutDelay { since } => (
            None,
            hold(false),
            json!({ "without_delay_since": since.to_string() }),
        ),
        Clock::Unknown => (None, "UNKNOWN", json!({ "unknown": true })),
        Clock::AwaitingAnchor(anchor) => (
            None,
            hold(false),
            json!({ "awaiting_anchor": anchor.as_str() }),
        ),
        Clock::Unresolved(reason) => (None, hold(false), json!({ "unresolved": reason })),
    }
}
