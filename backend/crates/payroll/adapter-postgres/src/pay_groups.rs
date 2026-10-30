// SPDX-License-Identifier: LicenseRef-Proprietary
//! Typed configuration only; scheduling consumes these explicit choices.
mod wire;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_payroll_domain::pay_groups::{PayDateRule, PaymentChannel, PeriodRule, ProrationBasis};
use console_platform_authz::Feature;
use console_platform_authz::access::{AccessEngineError, NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::residual::SqlValue;
use console_platform_authz::cedar_pbac::visible::load_facts;
use console_platform_db::with_audit;
use serde::{Deserialize, Serialize};
use sqlx::types::Json;
use time::OffsetDateTime;
use uuid::Uuid;
use wire::{ChannelWire, PayDateWire, PeriodWire, ProrationWire};

use crate::{PgPayrollError, PgPayrollStore};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreatePayGroup {
    pub legal_entity_id: Uuid,
    pub name: String,
    #[serde(with = "PayDateWire")]
    pub pay_date_rule: PayDateRule,
    #[serde(with = "PeriodWire")]
    pub base_period: PeriodRule,
    #[serde(with = "PeriodWire")]
    pub variable_period: PeriodRule,
    #[serde(with = "ProrationWire")]
    pub proration: ProrationBasis,
    #[serde(with = "ChannelWire")]
    pub channel: PaymentChannel,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PayGroup {
    pub id: Uuid,
    pub legal_entity_id: Uuid,
    pub name: String,
    #[serde(with = "PayDateWire")]
    pub pay_date_rule: PayDateRule,
    #[serde(with = "PeriodWire")]
    pub base_period: PeriodRule,
    #[serde(with = "PeriodWire")]
    pub variable_period: PeriodRule,
    #[serde(with = "ProrationWire")]
    pub proration: ProrationBasis,
    #[serde(with = "ChannelWire")]
    pub channel: PaymentChannel,
}

fn cedar_error(_: AccessEngineError) -> PgPayrollError {
    KernelError::unavailable("pay-group Cedar decision unavailable").into()
}

fn event(
    org: OrgId,
    actor: UserId,
    action: &str,
    target: Uuid,
) -> Result<AuditEvent, PgPayrollError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        "pay_group",
        target.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org))
}

impl PgPayrollStore {
    /// Persist every supplied rule verbatim, under live pay:edit for the owning entity.
    pub async fn create_pay_group(
        &self,
        org: OrgId,
        actor: UserId,
        input: CreatePayGroup,
    ) -> Result<PayGroup, PgPayrollError> {
        let id = Uuid::new_v4();
        let audit = event(org, actor, "payroll.pay_group_create", id)?;
        with_audit(&self.pool, audit, move |tx| Box::pin(async move {
            let facts = load_facts(tx, org, *actor.as_uuid()).await?;
            if !facts.authorize(Feature::PayrollRunManage.as_str(), NodeRef {
                kind: NodeKind::LegalEntity, id: input.legal_entity_id,
            }).map_err(cedar_error)? {
                return Err(KernelError::forbidden("pay-group creation requires entity pay:edit").into());
            }
            if !(1..=40).contains(&input.name.chars().count()) || input.name.trim_matches(' ').is_empty() {
                return Err(KernelError::validation("pay-group name requires 1–40 characters").with_field("name").into());
            }
            input.pay_date_rule.validate()?;
            input.base_period.validate("base_period")?;
            input.variable_period.validate("variable_period")?;
            Ok(sqlx::query_scalar::<_, Json<PayGroup>>(
                "INSERT INTO pay_groups(org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel)
                 VALUES ($1,$2,$3,$4->>'name',$4->'pay_date_rule',$4->'base_period',$4->'variable_period',$4->>'proration',$4->>'channel')
                 RETURNING to_jsonb(pay_groups)",
            ).bind(org.as_uuid()).bind(id).bind(input.legal_entity_id).bind(Json(&input))
                .fetch_one(tx.as_mut()).await?.0)
        })).await
    }

    /// The same Cedar snapshot controls rows and admission; narrower grants expose no other entity.
    pub async fn list_pay_groups(
        &self,
        org: OrgId,
        actor: UserId,
    ) -> Result<Vec<PayGroup>, PgPayrollError> {
        let audit = event(org, actor, "payroll.pay_group_list", *org.as_uuid())?;
        with_audit(&self.pool, audit, move |tx| {
            Box::pin(async move {
                let facts = load_facts(tx, org, *actor.as_uuid()).await?;
                let filter = facts
                    .visible(
                        Feature::PayrollRunRead.as_str(),
                        NodeKind::LegalEntity,
                        "g.legal_entity_id",
                        2,
                    )
                    .map_err(cedar_error)?;
                if filter.is_deny_all()
                    && !facts
                        .authorize(
                            Feature::PayrollRunRead.as_str(),
                            NodeRef {
                                kind: NodeKind::Tenant,
                                id: *org.as_uuid(),
                            },
                        )
                        .map_err(cedar_error)?
                {
                    return Err(
                        KernelError::forbidden("pay-group listing requires pay:view").into(),
                    );
                }
                let sql = format!(
                    "SELECT to_jsonb(g)
                 FROM pay_groups g WHERE g.org_id=$1 AND {} ORDER BY g.legal_entity_id,g.name,g.id",
                    filter.where_sql,
                );
                let mut query =
                    sqlx::query_scalar::<_, Json<PayGroup>>(sqlx::AssertSqlSafe(sql.as_str()))
                        .bind(org.as_uuid());
                for bind in &filter.binds {
                    let SqlValue::TextArray(values) = bind else {
                        return Err(
                            KernelError::unavailable("unsupported pay-group Cedar filter").into(),
                        );
                    };
                    query = query.bind(values);
                }
                Ok(query
                    .fetch_all(tx.as_mut())
                    .await?
                    .into_iter()
                    .map(|row| row.0)
                    .collect())
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cedar_failures_remain_unavailable() {
        for error in [
            AccessEngineError::Schema("invalid".into()),
            AccessEngineError::Compile("invalid".into()),
            AccessEngineError::Evaluation("invalid".into()),
            AccessEngineError::FactMissing("invalid".into()),
        ] {
            assert_eq!(
                cedar_error(error).kind(),
                console_kernel_core::ErrorKind::Unavailable
            );
        }
    }
}
