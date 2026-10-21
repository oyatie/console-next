//! The tenant's 사번 numbering rules (prefix + width per tenant, 법인 or
//! 사업장): list with the next number each would give, set, remove.

use console_hr_domain::import::numbering::{NumberRule, Numbering};
use console_platform_authz::{Feature, Principal};
use console_platform_db::{with_audits, with_org_conn};
use http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use super::facts::{rule_rows, taken_numbers};
use super::{audit, coded};
use crate::authz::{authorize_hr_org_wide, hr_reach};
use crate::{HrError, HrService};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NumberRuleRequest {
    /// `TENANT`, `LEGAL_ENTITY` or `WORKPLACE`.
    #[serde(deserialize_with = "deserialize_enum_14")]
    pub scope_kind: String,
    /// The 법인 or 사업장 id; omitted for `TENANT`.
    #[serde(default)]
    pub scope_id: Option<Uuid>,
    pub prefix: String,
    pub width: u8,
}

#[derive(Debug, Serialize)]
pub struct NumberRuleView {
    pub scope_kind: String,
    pub scope_id: Uuid,
    pub prefix: String,
    pub width: u8,
    /// The number this rule would give next (preview; nothing is reserved).
    pub next_number: String,
}

/// The checked `(kind, id)` of a rule scope in this tenant.
pub(crate) async fn scope(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    kind: &str,
    id: Option<Uuid>,
) -> Result<(&'static str, Uuid), HrError> {
    let (kind, sql) = match kind {
        "TENANT" => return Ok(("TENANT", org)),
        "LEGAL_ENTITY" => (
            "LEGAL_ENTITY",
            "SELECT EXISTS (SELECT 1 FROM legal_entities WHERE org_id = $1 AND id = $2)",
        ),
        "WORKPLACE" => (
            "WORKPLACE",
            "SELECT EXISTS (SELECT 1 FROM workplaces WHERE org_id = $1 AND id = $2)",
        ),
        _ => {
            return Err(HrError::validation(
                "scope_kind must be TENANT, LEGAL_ENTITY or WORKPLACE",
            ));
        }
    };
    let id = id.ok_or_else(|| HrError::validation("scope_id is required for this scope_kind"))?;
    let found: bool = sqlx::query_scalar(sql)
        .bind(org)
        .bind(id)
        .fetch_one(tx.as_mut())
        .await?;
    if found {
        Ok((kind, id))
    } else {
        Err(coded(
            StatusCode::NOT_FOUND,
            "not_found",
            "the 법인 or 사업장 was not found",
        ))
    }
}

pub(crate) fn checked_rule(prefix: &str, width: u8) -> Result<NumberRule, HrError> {
    let prefix = prefix.trim();
    let shape = prefix.chars().count() <= 16
        && prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !shape || !(1..=12).contains(&width) {
        return Err(HrError::validation(
            "prefix: up to 16 of A-Z a-z 0-9 _ -; width: 1-12",
        ));
    }
    Ok(NumberRule {
        prefix: prefix.to_owned(),
        width,
    })
}

impl HrService {
    pub async fn employee_number_rules(
        &self,
        principal: Principal,
    ) -> Result<Vec<NumberRuleView>, HrError> {
        hr_reach(&principal, Feature::EmployeeDirectoryManage)?;
        let org = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move {
                let mut numbering = Numbering {
                    taken: taken_numbers(tx, org).await?,
                    ..Numbering::default()
                };
                Ok(rule_rows(tx, org)
                    .await?
                    .into_iter()
                    .map(|(scope_kind, scope_id, rule)| NumberRuleView {
                        next_number: numbering.next(&rule),
                        scope_kind,
                        scope_id,
                        prefix: rule.prefix,
                        width: rule.width,
                    })
                    .collect())
            })
        })
        .await
    }

    pub async fn set_employee_number_rule(
        &self,
        principal: Principal,
        request: NumberRuleRequest,
    ) -> Result<NumberRuleView, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        let rule = checked_rule(&request.prefix, request.width)?;
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let org_uuid = *org.as_uuid();
                let (kind, id) = scope(tx, org_uuid, &request.scope_kind, request.scope_id).await?;
                sqlx::query(
                    "INSERT INTO employee_number_rules (org_id, scope_kind, scope_id, prefix, width, updated_by) \
                     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (org_id, scope_kind, scope_id) \
                     DO UPDATE SET prefix = EXCLUDED.prefix, width = EXCLUDED.width, \
                       updated_by = EXCLUDED.updated_by, updated_at = now()",
                )
                .bind(org_uuid)
                .bind(kind)
                .bind(id)
                .bind(&rule.prefix)
                .bind(i16::from(rule.width))
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;
                let mut numbering = Numbering { taken: taken_numbers(tx, org_uuid).await?, ..Numbering::default() };
                let view = NumberRuleView {
                    next_number: numbering.next(&rule),
                    scope_kind: kind.to_owned(),
                    scope_id: id,
                    prefix: rule.prefix,
                    width: rule.width,
                };
                let event = audit(org, actor, "employee.number_rule_set", "employee_number_rule", id.to_string(),
                    json!({ "scope_kind": kind, "prefix": view.prefix, "width": view.width }))?;
                Ok((view, vec![event]))
            })
        })
        .await
    }

    pub async fn remove_employee_number_rule(
        &self,
        principal: Principal,
        scope_kind: String,
        scope_id: Option<Uuid>,
    ) -> Result<(), HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let (org, actor) = (principal.org_id, principal.user_id);
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let org_uuid = *org.as_uuid();
                let (kind, id) = scope(tx, org_uuid, &scope_kind, scope_id).await?;
                let done = sqlx::query("DELETE FROM employee_number_rules WHERE org_id = $1 AND scope_kind = $2 AND scope_id = $3")
                    .bind(org_uuid)
                    .bind(kind)
                    .bind(id)
                    .execute(tx.as_mut())
                    .await?;
                if done.rows_affected() == 0 {
                    return Err(coded(StatusCode::NOT_FOUND, "not_found", "no rule for that scope"));
                }
                let event = audit(org, actor, "employee.number_rule_removed", "employee_number_rule", id.to_string(), json!({ "scope_kind": kind }))?;
                Ok(((), vec![event]))
            })
        })
        .await
    }
}

fn deserialize_enum_14<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["TENANT", "LEGAL_ENTITY", "WORKPLACE"],
    )
}
