// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_payroll_domain::reference_value;
use console_platform_authz::{
    Feature,
    access::{NodeKind, NodeRef},
    cedar_pbac::visible::load_facts,
};
use console_platform_db::with_audit;
use serde::Serialize;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

use crate::{
    PgPayrollError, PgPayrollStore,
    payslip_draft::{StatutoryCitation, statutory_citations_for_country_in_tx},
};

#[derive(Debug, Serialize)]
pub struct PayrollRates {
    pub country_code: Option<String>,
    pub adopted: bool,
    pub items: Vec<PayrollRate>,
}

#[derive(Debug, Serialize)]
pub struct PayrollRate {
    #[serde(flatten)]
    pub citation: StatutoryCitation,
    pub name: String,
    pub value: Option<String>,
    pub status: &'static str,
}

impl PgPayrollStore {
    pub async fn reference_rates(
        &self,
        org: OrgId,
        actor: UserId,
        entity: Uuid,
    ) -> Result<PayrollRates, PgPayrollError> {
        let audit = AuditEvent::new(
            Some(actor),
            AuditAction::new("payroll.reference_read")?,
            "legal_entity",
            entity.to_string(),
            TraceContext::generate(),
            OffsetDateTime::now_utc(),
        )
        .with_org(org);
        with_audit(&self.pool, audit, move |tx| {
            Box::pin(async move {
                let facts = load_facts(tx, org, *actor.as_uuid()).await?;
                if !facts
                    .authorize(
                        Feature::PayrollRunRead.as_str(),
                        NodeRef { kind: NodeKind::LegalEntity, id: entity },
                    )
                    .map_err(|_| KernelError::unavailable("payroll Cedar decision unavailable"))?
                {
                    return Err(KernelError::forbidden("reference rates require entity pay:view").into());
                }
                let pack: Option<(String, Date, bool)> = sqlx::query_as(
                    "SELECT p.country_code,(now() AT TIME ZONE p.time_zone)::date,
                    EXISTS(SELECT 1 FROM payroll_statutory_rates r WHERE r.country_code=p.country_code)
                 FROM legal_entities e JOIN lifecycle_country_packs p
                   ON p.time_zone=e.time_zone OR (e.time_zone IS NULL AND p.is_default)
                 WHERE e.org_id=$1 AND e.id=$2 AND e.voided_at IS NULL")
                .bind(org.as_uuid())
                .bind(entity)
                .fetch_optional(tx.as_mut())
                .await?;
                let Some((country_code, today, adopted)) = pack else {
                    return Ok(PayrollRates { country_code: None, adopted: false, items: vec![] });
                };
                let items = statutory_citations_for_country_in_tx(tx, today, Some(&country_code))
                    .await?
                    .into_iter()
                    .map(|citation| {
                        let value = reference_value(
                            citation.rate_num, citation.rate_den, citation.floor_won, citation.cap_won,
                        );
                        PayrollRate {
                            name: citation.instrument_ko.clone(),
                            status: if value.is_some() { "ACTIVE" } else { "HELD" },
                            value,
                            citation,
                        }
                    })
                    .collect();
                Ok(PayrollRates { country_code: Some(country_code), adopted, items })
            })
        }).await
    }
}
