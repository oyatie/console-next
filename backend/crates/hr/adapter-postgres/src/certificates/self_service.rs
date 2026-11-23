// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service certificate listing, reading, and issuance gated by Cedar `employee_self_read`.

use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{Postgres, QueryBuilder, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use super::{
    Certificate, CertificatePage, CertificateSummary, commands::audit, not_found, read::from_row,
    refused,
};
use crate::lifecycle::events_page::{LifecycleEventsQuery, encode_events_cursor};
use crate::{HrError, HrService};
use console_platform_authz::Principal;
use console_platform_authz::cedar_pbac::visible::{DecisionFacts, load_facts};
use console_platform_db::{settings_read::resolve_in_tx, with_audits};
use console_settings_domain::{SettingKey, SettingValue};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SelfCertificateKind {
    Employment,
    Career,
    Exit,
}

impl SelfCertificateKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Employment => "EMPLOYMENT",
            Self::Career => "CAREER",
            Self::Exit => "EXIT",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelfIssueCertificateRequest {
    pub kind: SelfCertificateKind,
    pub items: Vec<String>,
    pub purpose: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelfCertificateListQuery {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

pub(crate) async fn require_self_employee(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
) -> Result<(DecisionFacts, Uuid), HrError> {
    let facts = load_facts(tx, principal.org_id, *principal.user_id.as_uuid())
        .await
        .map_err(|_| {
            refused(
                http::StatusCode::FORBIDDEN,
                "forbidden",
                "self-service access facts are unavailable",
            )
        })?;
    let Some(employee_id) = facts.linked_employee_id() else {
        return Err(refused(
            http::StatusCode::FORBIDDEN,
            "employee_unlinked",
            "an active linked employee record is required for self-service",
        ));
    };
    let allowed = facts
        .authorize_employee_self_read(employee_id)
        .map_err(|_| {
            refused(
                http::StatusCode::FORBIDDEN,
                "forbidden",
                "self-service employee read is denied",
            )
        })?;
    if !allowed {
        return Err(refused(
            http::StatusCode::FORBIDDEN,
            "forbidden",
            "self-service employee read is denied",
        ));
    }
    Ok((facts, employee_id))
}

impl HrService {
    pub async fn my_certificates(
        &self,
        p: Principal,
        q: SelfCertificateListQuery,
    ) -> Result<CertificatePage, HrError> {
        with_audits::<_, _, HrError>(&self.pool, p.org_id, move |tx| {
            Box::pin(async move {
                let (_, employee_id) = require_self_employee(tx, &p).await?;
                let key = SettingKey::DisplayPageSize;
                let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
                    .fetch_one(tx.as_mut())
                    .await?;
                let resolved = resolve_in_tx(tx.as_mut(), p.org_id, &[key], None, now).await?;
                let size = match resolved
                    .get(&key)
                    .and_then(|r| r.as_ref().ok())
                    .map(|r| r.value)
                {
                    Some(SettingValue::Int(size)) => size,
                    _ => return Err(HrError::internal("display page size is not configured")),
                };
                let page = LifecycleEventsQuery {
                    limit: Some(q.limit.unwrap_or(size).clamp(1, size)),
                    cursor: q.cursor,
                }
                .page()?;
                let mut sql = QueryBuilder::<Postgres>::new(
                    "SELECT id, employee_id, certificate_no, snapshot->>'name' AS name, \
                     kind, purpose, replaces_id, issued_at, voided_at \
                     FROM hr_certificates WHERE org_id = ",
                );
                sql.push_bind(*p.org_id.as_uuid());
                sql.push(" AND employee_id = ").push_bind(employee_id);
                if let Some((at, id)) = page.before {
                    sql.push(" AND (issued_at, id) < (")
                        .push_bind(at)
                        .push(",")
                        .push_bind(id)
                        .push(")");
                }
                sql.push(" ORDER BY issued_at DESC, id DESC LIMIT ")
                    .push_bind(page.limit + 1);
                let mut items = sql
                    .build_query_as::<CertificateSummary>()
                    .fetch_all(tx.as_mut())
                    .await?;
                let has_more = i64::try_from(items.len()).unwrap_or(i64::MAX) > page.limit;
                if has_more {
                    items.pop();
                }
                let next_cursor = if has_more {
                    items
                        .last()
                        .map(|c| encode_events_cursor(c.issued_at, c.id))
                } else {
                    None
                };
                let audit = audit(
                    &p,
                    "certificate.self_list_read",
                    employee_id,
                    json!({
                        "self_read": true,
                        "employee_id": employee_id,
                        "certificate_ids": items.iter().map(|c| c.id).collect::<Vec<_>>(),
                    }),
                )?;
                Ok((CertificatePage { items, next_cursor }, vec![audit]))
            })
        })
        .await
    }

    pub async fn my_certificate(&self, p: Principal, id: Uuid) -> Result<Certificate, HrError> {
        with_audits::<_, _, HrError>(&self.pool, p.org_id, move |tx| {
            Box::pin(async move {
                let (_, employee_id) = require_self_employee(tx, &p).await?;
                let row = sqlx::query(
                    "SELECT * FROM hr_certificates WHERE org_id = $1 AND id = $2 AND employee_id = $3",
                )
                .bind(p.org_id.as_uuid())
                .bind(id)
                .bind(employee_id)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(not_found)?;
                let mut cert = from_row(&row)?;
                let png: Option<String> = sqlx::query_scalar(
                    "SELECT s.png FROM hr_certificates c \
                     JOIN hr_certificate_seals s ON s.org_id = c.org_id AND s.id = c.seal_id \
                     WHERE c.org_id = $1 AND c.id = $2",
                )
                .bind(p.org_id.as_uuid())
                .bind(id)
                .fetch_optional(tx.as_mut())
                .await?;
                if let Some(png) = png {
                    cert.snapshot["seal_png"] = json!(png);
                }
                let audit = audit(
                    &p,
                    "certificate.self_read",
                    cert.id,
                    json!({
                        "self_read": true,
                        "employee_id": employee_id,
                    }),
                )?;
                Ok((cert, vec![audit]))
            })
        })
        .await
    }
}
