// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{
    AuditAction, AuditCommandContext, AuditEvent, KernelError, OrgId, TenantPhase, TraceContext,
    UserId, WriteClass, tenant_phase::admit_write,
};
use console_payroll_domain::pay_groups::run_schedule::{derive_schedule, next_attribution_month};
use console_platform_authz::{Feature, cedar_pbac::visible::load_facts};
use console_platform_db::{audit_tx::with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction, types::Json};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::{PgPayrollError, PgPayrollStore, pay_groups::PayGroup};

time::serde::format_description!(date, Date, "[year]-[month]-[day]");

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RunKind {
    Regular,
    OffCycle,
    Correction,
    ExitSettlement,
}

impl RunKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Regular => "REGULAR",
            Self::OffCycle => "OFF_CYCLE",
            Self::Correction => "CORRECTION",
            Self::ExitSettlement => "EXIT_SETTLEMENT",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunRequest {
    pub pay_group_id: Uuid,
    pub kind: RunKind,
}

#[derive(Debug, Serialize)]
pub struct RunPreview {
    pub legal_entity_id: Uuid,
    pub pay_group_id: Uuid,
    pub kind: RunKind,
    pub attribution_month: String,
    #[serde(with = "date")]
    pub pay_date: Date,
    pub pay_date_clamped: bool,
    #[serde(with = "date")]
    pub period_start: Date,
    #[serde(with = "date")]
    pub period_end: Date,
    #[serde(with = "date")]
    pub variable_period_start: Date,
    #[serde(with = "date")]
    pub variable_period_end: Date,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayrollRunSummary {
    pub id: Uuid,
    pub legal_entity_id: Option<Uuid>,
    pub pay_group_id: Option<Uuid>,
    pub kind: Option<String>,
    pub attribution_month: Option<String>,
    #[serde(with = "date::option")]
    pub pay_date: Option<Date>,
    #[serde(with = "date")]
    pub period_start: Date,
    #[serde(with = "date")]
    pub period_end: Date,
    #[serde(with = "date::option")]
    pub variable_period_start: Option<Date>,
    #[serde(with = "date::option")]
    pub variable_period_end: Option<Date>,
    pub source_label: String,
    pub status: String,
    pub calculation_enabled: bool,
    pub created_by: Option<Uuid>,
    pub approved_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub approved_at: Option<OffsetDateTime>,
    pub close_receipt: Option<serde_json::Value>,
    pub submitted_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub submitted_at: Option<OffsetDateTime>,
    pub decided_by: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub decided_at: Option<OffsetDateTime>,
    pub decision_reason: Option<String>,
    pub approval_ref: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

impl PgPayrollStore {
    pub async fn preview_run(
        &self,
        org: OrgId,
        actor: UserId,
        input: RunRequest,
    ) -> Result<RunPreview, PgPayrollError> {
        let loader = self.clone();
        with_org_conn(&self.pool, org, move |tx| {
            Box::pin(async move { loader.derive_run_in_tx(tx, org, actor, &input).await })
        })
        .await
    }

    pub async fn create_run(
        &self,
        org: OrgId,
        actor: UserId,
        input: RunRequest,
    ) -> Result<PayrollRunSummary, PgPayrollError> {
        let id = Uuid::new_v4();
        let mut audit = AuditEvent::new(
            Some(actor),
            AuditAction::new("payroll.run_create")?,
            "payroll_draft_run",
            id.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(org);
        let loader = self.clone();
        with_audits(&self.pool, org, move |tx| {
            Box::pin(async move {
                let preview = loader.derive_run_in_tx(tx, org, actor, &input).await?;
                let phase: Option<String> = sqlx::query_scalar(
                    "SELECT phase FROM tenant_phase WHERE org_id=$1 FOR SHARE",
                )
                .bind(org.as_uuid())
                .fetch_optional(tx.as_mut())
                .await?;
                let mode = admit_write(
                    TenantPhase::from_db(phase.as_deref()),
                    WriteClass::Operational,
                )?;
                let mut context = AuditCommandContext::for_actor(Some(actor));
                context.change_mode = Some(mode);
                audit = audit.with_command_context(context);
                let inserted = sqlx::query(
                    "INSERT INTO payroll_draft_runs(org_id,id,pay_group_id,kind,attribution_month,pay_date,period_start,period_end,variable_period_start,variable_period_end,source_label,created_by)
                     VALUES ($1,$2,$3,$4,($5||'-01')::date,$6,$7,$8,$9,$10,$11,$12)",
                )
                .bind(org.as_uuid())
                .bind(id)
                .bind(input.pay_group_id)
                .bind(input.kind.as_str())
                .bind(&preview.attribution_month)
                .bind(preview.pay_date)
                .bind(preview.period_start)
                .bind(preview.period_end)
                .bind(preview.variable_period_start)
                .bind(preview.variable_period_end)
                .bind(id.to_string())
                .bind(actor.as_uuid())
                .execute(tx.as_mut())
                .await;
                if let Err(error) = inserted {
                    let constraint = error.as_database_error().and_then(|db| db.constraint());
                    if constraint == Some("payroll_regular_run_month_key") {
                        return Err(KernelError::conflict(
                            "a regular run already exists for this pay group and attribution month",
                        )
                        .with_code("regular_run_exists")
                        .into());
                    }
                    return Err(error.into());
                }
                let row = crate::fetch_run_row(tx, id)
                    .await?
                    .ok_or_else(|| KernelError::internal("created payroll run was not readable"))?;
                Ok((crate::run_summary_from_row(&row)?, vec![audit]))
            })
        })
        .await
    }

    pub(crate) async fn derive_run_in_tx(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        org: OrgId,
        actor: UserId,
        input: &RunRequest,
    ) -> Result<RunPreview, PgPayrollError> {
        let facts = load_facts(tx, org, *actor.as_uuid()).await?;
        if !facts
            .visible_pay_groups(tx, Feature::PayrollRunManage, self)
            .await?
            .contains(&input.pay_group_id)
        {
            return Err(KernelError::forbidden("run preparation requires pay-group pay:edit and sensitive:edit for sensitive groups").into());
        }
        if !matches!(input.kind, RunKind::Regular) {
            return Err(
                KernelError::validation("only regular payroll runs are supported")
                    .with_code("run_kind_unsupported")
                    .into(),
            );
        }
        let group = sqlx::query_scalar::<_, Json<PayGroup>>(
            "SELECT to_jsonb(g) FROM pay_groups g WHERE org_id=$1 AND id=$2",
        )
        .bind(org.as_uuid())
        .bind(input.pay_group_id)
        .fetch_one(tx.as_mut())
        .await?
        .0;
        let today: Date = sqlx::query_scalar("SELECT entity_today()")
            .fetch_one(tx.as_mut())
            .await?;
        let occupied: Vec<Date> = sqlx::query_scalar(
            "SELECT attribution_month FROM payroll_draft_runs
             WHERE org_id=$1 AND pay_group_id=$2 AND kind=$3 AND status<>'VOID'
             ORDER BY attribution_month",
        )
        .bind(org.as_uuid())
        .bind(group.id)
        .bind(input.kind.as_str())
        .fetch_all(tx.as_mut())
        .await?;
        let month = next_attribution_month(today, &occupied)?;
        let weekends: Vec<i16> = sqlx::query_scalar(
            "SELECT c.weekend_isodays FROM pay_groups g
             JOIN legal_entities e ON e.org_id=g.org_id AND e.id=g.legal_entity_id
             LEFT JOIN workplaces w ON w.org_id=e.org_id AND w.id=e.primary_workplace_id
             JOIN lifecycle_country_packs p ON p.time_zone=COALESCE(w.time_zone,e.time_zone)
               OR (COALESCE(w.time_zone,e.time_zone) IS NULL AND p.is_default)
             JOIN access_log_review_calendar c ON c.time_zone=p.time_zone
             WHERE g.org_id=$1 AND g.id=$2",
        )
        .bind(org.as_uuid())
        .bind(group.id)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            KernelError::unavailable("work calendar is not loaded")
                .with_code("holiday_calendar_missing")
        })?;
        let holidays: Vec<Date> = sqlx::query_scalar(
            "SELECT holiday_date FROM attendance_public_holidays ORDER BY holiday_date",
        )
        .fetch_all(tx.as_mut())
        .await?;
        let schedule = derive_schedule(
            month,
            group.pay_date_rule,
            group.base_period,
            group.variable_period,
            |day| {
                if !holidays.iter().any(|holiday| holiday.year() == day.year()) {
                    return Err(
                        KernelError::unavailable("holiday calendar year is not loaded")
                            .with_code("holiday_calendar_missing"),
                    );
                }
                let iso_day = i16::from(day.weekday().number_days_from_monday()) + 1;
                Ok(!weekends.contains(&iso_day) && !holidays.contains(&day))
            },
        )?;
        Ok(RunPreview {
            legal_entity_id: group.legal_entity_id,
            pay_group_id: group.id,
            kind: input.kind,
            attribution_month: format!("{:04}-{:02}", month.year(), month.month() as u8),
            pay_date: schedule.pay_date,
            pay_date_clamped: schedule.pay_date_clamped,
            period_start: schedule.base_start,
            period_end: schedule.base_end,
            variable_period_start: schedule.variable_start,
            variable_period_end: schedule.variable_end,
        })
    }
}
