// SPDX-License-Identifier: LicenseRef-Proprietary
//! Explicit configuration only. Scheduling and calculation interpret these rules later.
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_platform_authz::Feature;
use console_platform_authz::access::{AccessEngineError, NodeKind, NodeRef};
use console_platform_authz::cedar_pbac::residual::SqlValue;
use console_platform_authz::cedar_pbac::visible::load_facts;
use console_platform_db::with_audit;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{PgPayrollError, PgPayrollStore};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreatePayGroup {
    pub legal_entity_id: Uuid,
    pub name: String,
    pub pay_date_rule: String,
    pub base_period: String,
    pub variable_period: String,
    pub proration: String,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct PayGroup {
    pub id: Uuid,
    pub legal_entity_id: Uuid,
    pub name: String,
    pub pay_date_rule: String,
    pub base_period: String,
    pub variable_period: String,
    pub proration: String,
    pub channel: String,
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
            for (field, value) in [
                ("name", &input.name), ("pay_date_rule", &input.pay_date_rule),
                ("base_period", &input.base_period), ("variable_period", &input.variable_period),
                ("proration", &input.proration), ("channel", &input.channel),
            ] {
                if !(1..=200).contains(&value.trim_matches(' ').chars().count()) {
                    return Err(KernelError::validation("pay-group fields require 1–200 characters")
                        .with_field(field).into());
                }
            }
            Ok(sqlx::query_as(
                "INSERT INTO pay_groups(org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 RETURNING id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel",
            ).bind(org.as_uuid()).bind(id).bind(input.legal_entity_id).bind(input.name)
                .bind(input.pay_date_rule).bind(input.base_period).bind(input.variable_period)
                .bind(input.proration).bind(input.channel).fetch_one(tx.as_mut()).await?)
        })).await
    }

    /// The same Cedar snapshot controls rows and admission; narrower grants expose no other entity.
    pub async fn list_pay_groups(
        &self,
        org: OrgId,
        actor: UserId,
    ) -> Result<Vec<PayGroup>, PgPayrollError> {
        let audit = event(org, actor, "payroll.pay_group_list", *org.as_uuid())?;
        with_audit(&self.pool, audit, move |tx| Box::pin(async move {
            let facts = load_facts(tx, org, *actor.as_uuid()).await?;
            let filter = facts.visible(Feature::PayrollRunRead.as_str(), NodeKind::LegalEntity, "g.legal_entity_id", 2)
                .map_err(cedar_error)?;
            if filter.is_deny_all() && !facts.authorize(Feature::PayrollRunRead.as_str(), NodeRef {
                kind: NodeKind::Tenant, id: *org.as_uuid(),
            }).map_err(cedar_error)? {
                return Err(KernelError::forbidden("pay-group listing requires pay:view").into());
            }
            let sql = format!(
                "SELECT id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel
                 FROM pay_groups g WHERE g.org_id=$1 AND {} ORDER BY g.legal_entity_id,g.name,g.id", filter.where_sql,
            );
            let mut query = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str())).bind(org.as_uuid());
            for bind in &filter.binds {
                let SqlValue::TextArray(values) = bind else {
                    return Err(KernelError::unavailable("unsupported pay-group Cedar filter").into());
                };
                query = query.bind(values);
            }
            Ok(query.fetch_all(tx.as_mut()).await?)
        })).await
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
