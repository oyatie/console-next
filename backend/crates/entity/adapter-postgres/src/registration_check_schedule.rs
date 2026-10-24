// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::registration_check::{append, reconcile};
use crate::{PgEntityError, PgEntityStore};
use console_entity_application::registration_check::RegistrationCheck;
use console_kernel_core::{AuditAction, AuditEvent, OrgId, TraceContext};
use console_platform_db::with_audits;
use console_settings_domain::{SettingKey, SettingValue};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub struct CheckSchedulePolicy {
    pub cadence_hours: i64,
    pub batch_size: i64,
    pub daily_budget: i64,
    pub reflection_lag_days: i64,
    pub backoff_seconds: i64,
}
fn default_int(key: SettingKey) -> i64 {
    match key.def().default {
        Some(SettingValue::Int(n)) => n,
        _ => unreachable!("NTS numeric setting"),
    }
}
impl Default for CheckSchedulePolicy {
    fn default() -> Self {
        Self {
            cadence_hours: default_int(SettingKey::NtsCheckCadenceHours),
            batch_size: default_int(SettingKey::NtsCheckBatchSize),
            daily_budget: default_int(SettingKey::NtsCheckDailyBudget),
            reflection_lag_days: default_int(SettingKey::NtsCheckReflectionLagDays),
            backoff_seconds: default_int(SettingKey::NtsCheckBackoffSeconds),
        }
    }
}
impl PgEntityStore {
    /// Claim one batch. The port exposes only STATUS to this path, never user validation data.
    /// # Errors
    /// Database faults; provider failures commit the backoff without changing recorded status.
    pub async fn check_due_registrations(
        &self,
        org: OrgId,
        port: Arc<dyn RegistrationCheck>,
        policy: CheckSchedulePolicy,
    ) -> Result<usize, PgEntityError> {
        if !port.availability().available {
            return Ok(0);
        }
        with_audits(&self.pool, org, move |tx| Box::pin(async move {
            let mut rows: Vec<(Uuid,String)> = sqlx::query_as("SELECT r.id,r.brn FROM business_registration_check_schedule s JOIN business_registrations r ON r.id=s.registration_id \
                WHERE s.due_at<=now() AND r.brn IS NOT NULL AND r.voided_at IS NULL AND r.check_pack=$1 \
                ORDER BY s.due_at,r.id LIMIT $2 FOR UPDATE OF s,r SKIP LOCKED")
                .bind(port.pack()).bind(policy.batch_size.min(i64::try_from(port.max_batch()).unwrap_or(i64::MAX)).max(1)).fetch_all(tx.as_mut()).await?;
            if rows.is_empty() { return Ok((0, vec![])); }
            let allowed: i64 = sqlx::query_scalar("SELECT claim_registration_check_budget($1,$2)").bind(i64::try_from(rows.len()).unwrap_or(i64::MAX)).bind(policy.daily_budget).fetch_one(tx.as_mut()).await?;
            if allowed == 0 { return Ok((0, vec![])); }
            rows.truncate(usize::try_from(allowed).unwrap_or(0));
            let numbers: Vec<String> = rows.iter().map(|(_,n)| n.clone()).collect();
            let result = port.status(&numbers).await;
            let ids: Vec<Uuid> = rows.iter().map(|(id,_)| *id).collect();
            let delay = if result.is_ok() { policy.cadence_hours.saturating_mul(3600) } else { policy.backoff_seconds };
            sqlx::query("UPDATE business_registration_check_schedule SET due_at=now()+$2::bigint*interval '1 second' WHERE registration_id=ANY($1)")
                .bind(&ids).bind(delay).execute(tx.as_mut()).await?;
            let answers = match result {
                Ok(answers) => answers,
                Err(_) => { tracing::warn!("scheduled registration check unavailable; retry deferred"); return Ok((0, vec![])); }
            };
            let mut events = Vec::new();
            let mut count = 0;
            for (id, number) in rows {
                if let Some(answer) = answers.iter().find(|a| a.brn_checked == number) {
                    let check_id = append(tx, id, None, answer, None).await?;
                    reconcile(tx, id, policy.reflection_lag_days).await?;
                    events.push(AuditEvent::new(None, AuditAction::new("business_registration.check").map_err(console_entity_domain::Refusal::from)?, "business_registration", id.to_string(), TraceContext::generate(), time::OffsetDateTime::now_utc()).with_org(org).with_snapshots(None, Some(json!({"check_id":check_id,"trigger":"SCHEDULE","fields_sent":["b_no"]}))));
                    count += 1;
                }
            }
            Ok((count, events))
        })).await
    }
}
