//! The worker tick's void PII destruction: a voided record keeps its personal
//! data for `people.void_pii_retention` days (a dispute or a mistaken void
//! can still be looked into), then becomes a tombstone (id, 사번, dates, void
//! facts). Claimed with `FOR UPDATE SKIP LOCKED`, so replicas never collide.
//! The 3-year 근로자 명부 floor of an EXITED record is not here: its disposal
//! is the tenant's governed retention review (decisions #10), never a timer.

use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_ontology_canonical_adapter_postgres::employee_void::{
    destroy_voided_pii_in_tx, include_voided,
};
use console_platform_db::{with_audits, with_org_conn};
use console_settings_domain::SettingKey;
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

use super::facts::int_setting;
use crate::{HrError, HrService};

/// At most this many records per tenant per tick.
const BATCH: i64 = 100;

impl HrService {
    /// Destroys the personal data of every voided record past the tenant's
    /// retention. One tenant's fault is logged and retried next tick.
    /// Returns how many records were tombstoned.
    ///
    /// # Errors
    /// Only the tenant listing itself.
    pub async fn destroy_due_void_pii(&self) -> Result<usize, HrError> {
        let orgs: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM platform_list_organizations()")
            // rls-arming: ok platform_list_organizations() is the SECURITY DEFINER id-only tenant discovery; every per-org statement below runs under with_audits
            .fetch_all(&self.pool)
            .await?;
        let mut destroyed = 0;
        for org_uuid in orgs {
            match self.destroy_due_in(OrgId::from_uuid(org_uuid)).await {
                Ok(n) => destroyed += n,
                Err(error) => tracing::warn!(
                    org = %org_uuid,
                    error = %error.message,
                    "void PII destruction failed; retrying next run"
                ),
            }
        }
        Ok(destroyed)
    }

    async fn destroy_due_in(&self, org: OrgId) -> Result<usize, HrError> {
        let org_uuid = *org.as_uuid();
        // Cheap probe first: most tenants have nothing voided.
        let any: bool = with_org_conn::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                include_voided(tx, true).await?;
                Ok(sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM employees WHERE org_id = $1 \
                     AND voided_at IS NOT NULL AND pii_destroyed_at IS NULL)",
                )
                .bind(org_uuid)
                .fetch_one(tx.as_mut())
                .await?)
            })
        })
        .await?;
        if !any {
            return Ok(0);
        }
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                let days = int_setting(tx, org_uuid, SettingKey::PeopleVoidPiiRetention).await?;
                include_voided(tx, true).await?;
                let due: Vec<(Uuid, Option<String>)> = sqlx::query_as(
                    "SELECT id, employee_number FROM employees WHERE org_id = $1 \
                     AND voided_at IS NOT NULL AND pii_destroyed_at IS NULL \
                     AND voided_at <= now() - make_interval(days => $2::int) \
                     ORDER BY voided_at LIMIT $3 FOR UPDATE SKIP LOCKED",
                )
                .bind(org_uuid)
                .bind(days)
                .bind(BATCH)
                .fetch_all(tx.as_mut())
                .await?;
                include_voided(tx, false).await?;
                let mut events = Vec::with_capacity(due.len());
                for (employee_id, employee_number) in &due {
                    destroy_voided_pii_in_tx(tx, *employee_id, false).await?;
                    events.push(
                        AuditEvent::new(
                            None,
                            AuditAction::new("employee.pii_destroyed")
                                .map_err(HrError::from_kernel)?,
                            "employee",
                            employee_id.to_string(),
                            TraceContext::generate(),
                            OffsetDateTime::now_utc(),
                        )
                        .with_org(org)
                        .with_snapshots(
                            None,
                            Some(json!({
                                "employee_number": employee_number,
                                "retention_days": days,
                                "basis": "people.void_pii_retention",
                            })),
                        ),
                    );
                }
                Ok((due.len(), events))
            })
        })
        .await
    }
}
