// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::*;
use console_settings_domain::SettingValue;
use serde_json::json;

impl PgOrgChangeStore {
    pub async fn get_for_viewer(
        &self,
        actor: UserId,
        id: Uuid,
    ) -> Result<OrgChangeDetail, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        let port = self.sole_holder_decision.clone();
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move {
                let mut detail = load_detail(tx, id)
                    .await?
                    .ok_or_else(|| KernelError::not_found("org-change request was not found"))?;
                attach_offer(tx, org, actor, id, port.as_deref(), &mut detail).await?;
                Ok(detail)
            })
        })
        .await
    }

    /// Server consent facts for the sole holder; no business decision is recorded.
    pub async fn sole_holder_consent(
        &self,
        actor: UserId,
        id: Uuid,
    ) -> Result<Option<Value>, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        let port = self.sole_holder_decision.clone();
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move { consent(tx, org, actor, id, port.as_deref()).await })
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
        "notice_template":"org_change.sole_holder.recorded.v1"});
    let hash = fingerprint(&payload);
    Ok(Some(
        json!({"payload":payload,"payload_hash":hash,"expected_version":detail.version,"step_id":step,"recipients":recipients}),
    ))
}

pub(super) async fn attach_offer(
    tx: Tx<'_, '_>,
    org: OrgId,
    actor: UserId,
    id: Uuid,
    port: Option<&dyn SoleHolderDecisionPort>,
    detail: &mut OrgChangeDetail,
) -> Result<(), PgOrgChangeError> {
    if let Some(snapshot) = consent(tx, org, actor, id, port).await? {
        // A concurrent decision may have advanced the document while this read was assembling.
        if snapshot["expected_version"].as_str() != Some(detail.version.as_str()) {
            return Ok(());
        }
        let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
            .fetch_one(tx.as_mut())
            .await?;
        detail.sole_holder_decision = Some(console_orgchange_domain::SoleHolderDecision {
            step_id: serde_json::from_value(snapshot["step_id"].clone())
                .map_err(|_| KernelError::internal("decision step unavailable"))?,
            expected_version: detail.version.clone(),
            payload_hash: snapshot["payload_hash"]
                .as_str()
                .ok_or_else(|| KernelError::internal("decision fingerprint unavailable"))?
                .to_owned(),
            notice_count: snapshot["payload"]["notice_count"]
                .as_i64()
                .ok_or_else(|| KernelError::internal("decision notice count unavailable"))?,
            review_due_at: now
                + time::Duration::days(
                    snapshot["payload"]["review_days"].as_i64().ok_or_else(|| {
                        KernelError::internal("decision review period unavailable")
                    })?,
                ),
        });
    }
    Ok(())
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
