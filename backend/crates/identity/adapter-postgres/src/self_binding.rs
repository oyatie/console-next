// SPDX-License-Identifier: LicenseRef-Proprietary
//! Governed self-binding; the receipt preserves the eligibility and review clock.
use crate::{PgOrgError, PgOrgStore, account_link_solo, policy::versions::bump_subject_version_tx};
use console_identity_application::user_audit_event;
use console_kernel_core::{KernelError, TraceContext, UserId};
use console_platform_auth::{
    MobilePasskeyStepUpBinding, MobilePasskeyStepUpEnvelope, MobileStepUpActionKind, PasskeyService,
};
use console_platform_db::with_phase_audits;
use console_platform_request_context::current_org;
use console_settings_domain::{SettingKey, SettingValue};
use serde_json::json;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub struct SelfBindingCommand {
    pub actor: UserId,
    pub employee: Uuid,
    pub step_up: MobilePasskeyStepUpEnvelope,
    pub trace: TraceContext,
}

impl PgOrgStore {
    /// Apply one self-attested binding after reloading Cedar facts under the tenant write lock.
    /// The passkey assertion, binding, receipt, freshness bump and audit commit together.
    /// # Errors
    /// Ineligible actors, missing or linked employees, and invalid or replayed step-up assertions.
    pub async fn self_bind_account(
        &self,
        command: SelfBindingCommand,
        passkeys: &PasskeyService,
    ) -> Result<Uuid, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let passkeys = passkeys.clone();
        with_phase_audits(&self.pool, org, move |tx| Box::pin(async move {
            let SelfBindingCommand { actor, employee, step_up, trace } = command;
            sqlx::query("SELECT id FROM users WHERE org_id=$1 AND id=$2 FOR UPDATE")
                .bind(org.as_uuid()).bind(actor.as_uuid()).fetch_optional(tx.as_mut()).await?;
            let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
                .fetch_one(tx.as_mut()).await?;
            let payload = json!({"command":"account_link.self_bind","org_id":org,"account_id":actor,"employee_id":employee});
            let hash: String = sqlx::query_scalar("SELECT governed_exception_fingerprint($1,'{}'::daterange[])")
                .bind(&payload).fetch_one(tx.as_mut()).await?;
            let binding = MobilePasskeyStepUpBinding::bound(MobileStepUpActionKind::ExceptionDecide, *actor.as_uuid(), hash);
            let assertion = passkeys.verify_and_record_step_up_in_tx(tx, step_up, *actor.as_uuid(), &binding)
                .await.map_err(|_| KernelError::forbidden("The passkey assertion does not authorize this command").with_code("step_up_failed"))?;
            let facts = account_link_solo::facts_in_tx(tx, org, actor, actor).await?;
            if !account_link_solo::decide(org, actor, facts)? {
                return Err(KernelError::forbidden("Self-binding is available only to an unlinked sole operator")
                    .with_code("account_link.refuse.solo_ineligible").into());
            }
            let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM employees WHERE org_id=$1 AND id=$2 FOR UPDATE")
                .bind(org.as_uuid()).bind(employee).fetch_optional(tx.as_mut()).await?;
            if exists.is_none() {
                return Err(KernelError::not_found("Employee record not found").into());
            }
            let taken: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE org_id=$1 AND employee_id=$2)")
                .bind(org.as_uuid()).bind(employee).fetch_one(tx.as_mut()).await?;
            if taken {
                return Err(KernelError::conflict("Employee is already linked to another account")
                    .with_code("account_link.refuse.employee_taken").into());
            }
            let key = SettingKey::ReviewSoleHolderExceptionDue;
            let settings = console_settings_adapter_postgres::resolve_in_tx(tx.as_mut(), org, &[key], None, now).await?;
            let days = match settings.get(&key).and_then(|value| value.as_ref().ok()).map(|value| value.value) {
                Some(SettingValue::Int(days)) => i32::try_from(days).map_err(|_| KernelError::internal("Review deadline is out of range"))?,
                _ => return Err(KernelError::internal("Review deadline is unavailable").into()),
            };
            let eligibility = serde_json::to_value(facts).map_err(|error| KernelError::internal(error.to_string()))?;
            sqlx::query("INSERT INTO account_link_self_attestations(id,org_id,account_id,employee_id,attested_at,eligibility,review_days,review_due_at) \
                VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
                .bind(assertion).bind(org.as_uuid()).bind(actor.as_uuid()).bind(employee).bind(now)
                .bind(&eligibility).bind(days).bind(now + Duration::days(i64::from(days))).execute(tx.as_mut()).await?;
            sqlx::query("UPDATE users SET employee_id=$3 WHERE org_id=$1 AND id=$2")
                .bind(org.as_uuid()).bind(actor.as_uuid()).bind(employee).execute(tx.as_mut()).await?;
            bump_subject_version_tx(tx, *org.as_uuid(), *actor.as_uuid(), now).await?;
            let event = user_audit_event("account_link.self_attested", Some(actor), actor, trace, now)?.with_org(org)
                .with_snapshots(Some(json!({"employee_id":null})), Some(json!({"employee_id":employee,
                    "self_attestation_id":assertion,"eligibility":eligibility,"review_setting":key.as_str(),"review_days":days})));
            Ok((assertion, vec![event]))
        })).await
    }
}
