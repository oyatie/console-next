// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_settings_domain::SettingValue;
use serde_json::json;

impl PgOrgChangeStore {
    /// Server consent facts for the sole holder; no business decision is recorded.
    pub async fn sole_holder_consent(
        &self,
        actor: UserId,
        id: Uuid,
    ) -> Result<Option<Value>, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        let port = self.sole_holder_decision.clone();
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move {
                lock_request(tx, id).await?;
                consent(tx, org, actor, id, port.as_deref()).await
            })
        })
        .await
    }
}

pub(super) async fn consent(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
    port: Option<&dyn SoleHolderDecisionPort>,
) -> Result<Option<Value>, PgOrgChangeError> {
    let Some((step, other_holder)) =
        super::sole_holder::sole_holder_facts_in_tx(tx, org, actor, id).await?
    else {
        return Ok(None);
    };
    let detail = require_detail(tx, id).await?;
    let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
        .fetch_one(tx.as_mut())
        .await?;
    let keys = [
        SettingKey::ReviewSoleHolderExceptionDue,
        SettingKey::ExceptionsApprovalTtlDays,
    ];
    let settings =
        console_settings_adapter_postgres::resolve_in_tx(tx.as_mut(), org, &keys, None, now)
            .await?;
    let int = |key| match settings
        .get(&key)
        .and_then(|v| v.as_ref().ok())
        .map(|v| v.value)
    {
        Some(SettingValue::Int(n)) => Ok(n),
        _ => Err(KernelError::internal(
            "sole-holder review settings unavailable",
        )),
    };
    let port = port.ok_or_else(|| KernelError::unavailable("sole-holder decisions unavailable"))?;
    let mut recipients = port.recipients(tx, org, actor).await?;
    recipients.sort_unstable();
    recipients.dedup();
    let payload = json!({"org_id":org,"request_id":id,"step_id":step,"actor":actor,
        "expected_version":detail.version,"proposal":detail.proposal,"effective_date":detail.summary.effective_date.to_string(),
        "reason":detail.summary.reason,"target":detail.summary.target,"kind":detail.summary.kind,
        "review_days":int(SettingKey::ReviewSoleHolderExceptionDue)?,"approval_ttl_days":int(SettingKey::ExceptionsApprovalTtlDays)?,
        "other_eligible_holders":u64::from(other_holder),
        "notice_count":recipients.len(),"recipients_hash":fingerprint(&json!(recipients)),
        "notice_body":"단독 권한 보유자가 본인 확인 후 조직 변경의 결재 단계를 승인했습니다. 사후 검토가 필요합니다."});
    let hash = fingerprint(&payload);
    Ok(Some(
        json!({"payload":payload,"payload_hash":hash,"expected_version":detail.version,"step_id":step,"recipients":recipients}),
    ))
}

pub(super) async fn record(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
    command: &console_orgchange_domain::StepDecisionCommand,
    assertion: Value,
    port: Option<&dyn SoleHolderDecisionPort>,
) -> Result<Uuid, PgOrgChangeError> {
    let snapshot = consent(tx, org, actor, id, port).await?.ok_or_else(|| {
        KernelError::forbidden("sole-holder decision is unavailable")
            .with_code("org_change_sod_violation")
    })?;
    let version = snapshot["expected_version"]
        .as_str()
        .ok_or_else(|| KernelError::internal("decision version unavailable"))?;
    if command.expected_version.as_deref() != Some(version) {
        return Err(PgOrgChangeError::StaleVersion(version.to_owned()));
    }
    let port = port.ok_or_else(|| KernelError::unavailable("sole-holder decisions unavailable"))?;
    Ok(port.record(tx, actor, snapshot, assertion).await?)
}
