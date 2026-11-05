// SPDX-License-Identifier: LicenseRef-Proprietary
//! Issuance setup facts without numbering, seals or other entities' settings.
use crate::{HrError, HrService};
use console_platform_authz::Principal;
use console_platform_db::with_org_conn;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CertificatePreconditionQuery {
    pub employee_id: Uuid,
}
#[derive(Debug, Serialize)]
pub struct CertificatePrecondition {
    pub settings_configured: bool,
    pub reason_code: Option<&'static str>,
}
impl HrService {
    pub async fn certificate_precondition(
        &self,
        p: Principal,
        employee: Uuid,
    ) -> Result<CertificatePrecondition, HrError> {
        with_org_conn::<_, _, HrError>(&self.pool, p.org_id, move |tx| Box::pin(async move {
            super::access::person(tx, &p, "certificate_issue", employee).await?;
            let entity: Option<Uuid> = sqlx::query_scalar("SELECT ea.legal_entity_id FROM employees e LEFT JOIN employment_resolved_assignments ea ON ea.org_id=e.org_id AND ea.employee_id=e.id WHERE e.org_id=$1 AND e.id=$2")
                .bind(p.org_id.as_uuid()).bind(employee).fetch_optional(tx.as_mut()).await?
                .ok_or_else(super::not_found)?;
            let configured = if let Some(entity) = entity {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM hr_certificate_entity_settings WHERE org_id=$1 AND legal_entity_id=$2)")
                    .bind(p.org_id.as_uuid()).bind(entity).fetch_one(tx.as_mut()).await?
            } else { false };
            Ok(CertificatePrecondition {
                settings_configured: configured,
                reason_code: if entity.is_none() { Some("certificate_facts_missing") }
                    else if !configured { Some("certificate_settings_required") } else { None },
            })
        })).await
    }
}
