// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{KernelError, OrgId, UserId};
use console_payroll_domain::pay_groups::run_schedule::derive_schedule;
use console_platform_authz::{Feature, cedar_pbac::visible::load_facts};
use console_platform_db::with_org_conn;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction, types::Json};
use time::{Date, Weekday};
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
        let group = sqlx::query_scalar::<_, Json<PayGroup>>(
            "SELECT to_jsonb(g) FROM pay_groups g WHERE org_id=$1 AND id=$2",
        )
        .bind(org.as_uuid())
        .bind(input.pay_group_id)
        .fetch_one(tx.as_mut())
        .await?
        .0;
        let kind = serde_json::to_value(input.kind)
            .map_err(|_| KernelError::internal("run kind serialization failed"))?;
        let month: Date = sqlx::query_scalar("SELECT d::date FROM generate_series(date_trunc('month',entity_today()),date_trunc('month',entity_today())+(SELECT count(*) FROM payroll_draft_runs WHERE org_id=$1 AND pay_group_id=$2 AND kind=$3)*interval '1 month',interval '1 month') d WHERE NOT EXISTS(SELECT 1 FROM payroll_draft_runs WHERE org_id=$1 AND pay_group_id=$2 AND kind=$3 AND attribution_month=d::date AND status<>'VOID') ORDER BY d LIMIT 1")
            .bind(org.as_uuid()).bind(group.id).bind(kind.as_str()).fetch_one(tx.as_mut()).await?;
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
                Ok(
                    !matches!(day.weekday(), Weekday::Saturday | Weekday::Sunday)
                        && !holidays.contains(&day),
                )
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
