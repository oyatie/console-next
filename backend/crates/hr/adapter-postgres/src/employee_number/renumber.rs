//! Bulk renumbering (decisions #25): a new scheme for the tenant, a 법인 or
//! a 사업장 — the current people of the scope (재직, 휴직, 입사 예정; former
//! employees keep their numbers) numbered from 1 by 입사일, then current
//! 사번, old → new, with every number someone else holds or held named as a
//! conflict. The preview's digest binds the apply to what was shown.

use console_hr_domain::import::numbering::{RenumberLine, plan_renumber};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::Postgres;
use uuid::Uuid;

use super::facts::taken_numbers;
use super::rules::{checked_rule, scope};
use crate::authz::authorize_hr_org_wide;
use crate::digest::sha256_hex;
use crate::{HrError, HrService};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RenumberRequest {
    #[serde(deserialize_with = "deserialize_enum_13")]
    pub scope_kind: String,
    #[serde(default)]
    pub scope_id: Option<Uuid>,
    pub prefix: String,
    pub width: u8,
    /// `YYYY-MM-DD`, today or earlier.
    pub effective_date: String,
    pub reason_code: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RenumberPreview {
    pub lines: Vec<RenumberLine>,
    pub conflicts: usize,
    /// sha-256 of the request and the lines; the apply names it.
    pub preview_digest: String,
}

/// The current people of the scope as `(id, 사번)`, in numbering order.
async fn people(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    kind: &str,
    id: Uuid,
) -> Result<Vec<(Uuid, Option<String>)>, HrError> {
    Ok(sqlx::query_as(
        "SELECT e.id, e.employee_number FROM person_employees_current e WHERE e.org_id = $1 \
           AND e.employment_status IN ('ACTIVE', 'ON_LEAVE', 'PRE_HIRE') \
           AND ($3 = 'TENANT' OR EXISTS (SELECT 1 FROM employment_assignments a \
                WHERE a.org_id = e.org_id AND a.employee_id = e.id \
                  AND a.superseded_at IS NULL AND a.valid_to IS NULL \
                  AND (($3 = 'LEGAL_ENTITY' AND a.legal_entity_id = $2) \
                    OR ($3 = 'WORKPLACE' AND a.workplace_id = $2)))) \
         ORDER BY e.hire_date NULLS LAST, e.employee_number NULLS LAST, e.id",
    )
    .bind(org)
    .bind(id)
    .bind(kind)
    .fetch_all(tx.as_mut())
    .await?)
}

/// The preview of `request` in the armed transaction.
pub(crate) async fn preview_in_tx(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: Uuid,
    request: &RenumberRequest,
) -> Result<(RenumberPreview, &'static str, Uuid), HrError> {
    let rule = checked_rule(&request.prefix, request.width)?;
    let (kind, id) = scope(tx, org, &request.scope_kind, request.scope_id).await?;
    let lines = plan_renumber(
        &people(tx, org, kind, id).await?,
        &rule,
        &taken_numbers(tx, org).await?,
    );
    let bytes = serde_json::to_vec(&json!({ "request": request, "lines": lines }))
        .map_err(|_| HrError::internal("renumber preview could not be serialized"))?;
    let preview = RenumberPreview {
        conflicts: lines.iter().filter(|l| l.conflict.is_some()).count(),
        preview_digest: sha256_hex(&bytes),
        lines,
    };
    Ok((preview, kind, id))
}

impl HrService {
    pub async fn preview_renumber(
        &self,
        principal: Principal,
        request: RenumberRequest,
    ) -> Result<RenumberPreview, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let org = *principal.org_id.as_uuid();
        with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move { Ok(preview_in_tx(tx, org, &request).await?.0) })
        })
        .await
    }
}

fn deserialize_enum_13<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["TENANT", "LEGAL_ENTITY", "WORKPLACE"],
    )
}
