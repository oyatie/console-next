// SPDX-License-Identifier: LicenseRef-Proprietary
//! Typed configuration only; scheduling consumes these explicit choices.
mod facts;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PayBasis {
    Monthly,
    Hourly,
}

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
    pub sensitive: bool,
    pub pay_basis_allowed: Vec<PayBasis>,
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
    pub sensitive: Option<bool>,
    pub pay_basis_allowed: Option<Vec<PayBasis>>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PayGroupEntity {
    pub id: Uuid,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PayGroupPage {
    pub items: Vec<PayGroup>,
    pub legal_entities: Vec<PayGroupEntity>,
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
            if !facts.authorize_pay_group_creation(input.legal_entity_id, input.sensitive).map_err(cedar_error)? {
                return Err(KernelError::forbidden("pay-group creation requires entity pay:edit and sensitive:edit for sensitive groups").into());
            }
            if !(1..=40).contains(&input.name.chars().count()) || input.name.trim_matches(' ').is_empty() {
                return Err(KernelError::validation("pay-group name requires 1–40 characters").with_field("name").into());
            }
            input.pay_date_rule.validate()?;
            input.base_period.validate("base_period")?;
            input.variable_period.validate("variable_period")?;
            if input.pay_basis_allowed.is_empty() || input.pay_basis_allowed.iter().enumerate().any(|(i, basis)| input.pay_basis_allowed[..i].contains(basis)) {
                return Err(KernelError::validation("select distinct allowed pay bases").with_field("pay_basis_allowed").into());
            }
            Ok(sqlx::query_scalar::<_, Json<PayGroup>>(
                "INSERT INTO pay_groups(org_id,id,legal_entity_id,name,pay_date_rule,base_period,variable_period,proration,channel,sensitive,pay_basis_allowed)
                 VALUES ($1,$2,$3,$4->>'name',$4->'pay_date_rule',$4->'base_period',$4->'variable_period',$4->>'proration',$4->>'channel',($4->>'sensitive')::boolean,ARRAY(SELECT jsonb_array_elements_text($4->'pay_basis_allowed')))
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
    ) -> Result<PayGroupPage, PgPayrollError> {
        let audit = event(org, actor, "payroll.pay_group_list", *org.as_uuid())?;
        let loader = self.clone();
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
                let ids = facts.visible_pay_groups(tx, Feature::PayrollRunRead, &loader).await?;
                let items = sqlx::query_scalar::<_, Json<PayGroup>>(
                    "SELECT to_jsonb(g) FROM pay_groups g WHERE g.org_id=$1 AND g.id=ANY($2)
                     ORDER BY g.legal_entity_id,g.name,g.id",
                ).bind(org.as_uuid()).bind(ids)
                    .fetch_all(tx.as_mut())
                    .await?
                    .into_iter()
                    .map(|row| row.0)
                    .collect();
                let sql = format!(
                    "SELECT jsonb_build_object('id',g.legal_entity_id,'name',r.name)
                     FROM (SELECT org_id,id AS legal_entity_id FROM legal_entities WHERE voided_at IS NULL) g
                     LEFT JOIN LATERAL (SELECT name FROM legal_entity_revisions r WHERE r.org_id=g.org_id
                        AND r.legal_entity_id=g.legal_entity_id AND r.effective_from<=entity_today()
                        ORDER BY r.effective_from DESC,r.version DESC LIMIT 1) r ON true
                     WHERE g.org_id=$1 AND {} ORDER BY r.name,g.legal_entity_id", filter.where_sql);
                let mut query = sqlx::query_scalar::<_, Json<PayGroupEntity>>(sqlx::AssertSqlSafe(sql.as_str())).bind(org.as_uuid());
                for bind in &filter.binds {
                    let SqlValue::TextArray(values) = bind else { return Err(KernelError::unavailable("unsupported pay-group Cedar filter").into()); };
                    query = query.bind(values);
                }
                let legal_entities = query.fetch_all(tx.as_mut()).await?.into_iter().map(|row| row.0).collect();
                Ok(PayGroupPage { items, legal_entities })
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
