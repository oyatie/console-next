// SPDX-License-Identifier: LicenseRef-Proprietary
use console_governance_adapter_postgres::exception::{
    ExceptionRequest, GovernedWrite, consume_exception_conn, request_exception_conn,
};
use console_governance_domain::exception::{
    ExceptionSettings, RuleCode, SoleHolderMode, SubjectType,
};
use console_identity_adapter_postgres::second_person::{HolderCapability, PgHolderResolver};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_orgchange_adapter_postgres::{OrgUnitWriteFuture, SoleHolderDecisionPort};
use console_platform_auth::{MobilePasskeyStepUpBinding, MobileStepUpActionKind, PasskeyService};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

pub(crate) struct PgSoleHolderDecisionPort(pub PasskeyService);

impl SoleHolderDecisionPort for PgSoleHolderDecisionPort {
    fn recipients<'tx>(
        &self,
        tx: &'tx mut Transaction<'_, Postgres>,
        org: OrgId,
        actor: UserId,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<Uuid>, KernelError>> + Send + 'tx>,
    > {
        Box::pin(async move {
            let recipients = PgHolderResolver {
                tx,
                org,
                capability: HolderCapability::OrgRead,
                exclude_account: Some(*actor.as_uuid()),
                exclude_employee: None,
                include_ops: true,
                now: time::OffsetDateTime::now_utc(),
            }
            .resolve_at_most(usize::MAX)
            .await?;
            let recipients: Vec<Uuid> = recipients.into_iter().collect();
            let mut independent: Vec<Uuid> = sqlx::query_scalar(
                "SELECT DISTINCT ON (coalesce(u.person_id,u.id)) u.id FROM users u \
                 JOIN users actor ON actor.org_id=u.org_id AND actor.id=$2 \
                 WHERE u.org_id=$1 AND u.id=ANY($3) \
                   AND (actor.person_id IS NULL OR u.person_id IS DISTINCT FROM actor.person_id) \
                 ORDER BY coalesce(u.person_id,u.id),u.id",
            )
            .bind(org.as_uuid())
            .bind(actor.as_uuid())
            .bind(recipients)
            .fetch_all(tx.as_mut())
            .await
            .map_err(|_| KernelError::internal("notice identities unavailable"))?;
            // No independent reader: send the actor a self-receipt.
            if independent.is_empty() {
                independent.push(*actor.as_uuid());
            }
            Ok(independent)
        })
    }

    fn record<'tx>(
        &self,
        tx: &'tx mut Transaction<'_, Postgres>,
        actor: UserId,
        consent: Value,
        step_up: Value,
    ) -> OrgUnitWriteFuture<'tx> {
        let passkeys = self.0.clone();
        Box::pin(record_in_tx(tx, passkeys, actor, consent, step_up))
    }
}

async fn record_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    passkeys: PasskeyService,
    actor: UserId,
    consent: Value,
    step_up: Value,
) -> Result<Uuid, KernelError> {
    let payload = &consent["payload"];
    let invalid = || KernelError::internal("sole-holder consent unavailable");
    let request: Uuid =
        serde_json::from_value(payload["request_id"].clone()).map_err(|_| invalid())?;
    let binding = MobilePasskeyStepUpBinding::bound(
        MobileStepUpActionKind::ExceptionDecide,
        request,
        consent["payload_hash"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned(),
    );
    let failed = || KernelError::forbidden("step_up_failed").with_code("step_up_failed");
    let envelope = serde_json::from_value(step_up).map_err(|_| failed())?;
    let assertion = passkeys
        .verify_and_record_step_up_in_tx(tx, envelope, *actor.as_uuid(), &binding)
        .await
        .map_err(|_| failed())?;
    let settings = ExceptionSettings {
        approval_ttl_days: payload["approval_ttl_days"]
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .ok_or_else(invalid)?,
        sole_holder_mode: SoleHolderMode::StepUpNoticeReview,
        sole_holder_review_due: Duration::from_secs(
            payload["review_days"]
                .as_u64()
                .and_then(|n| n.checked_mul(86_400))
                .ok_or_else(invalid)?,
        ),
    };
    let rule = RuleCode::OrgChangeSoleHolder;
    let exception = request_exception_conn(
        tx.as_mut(),
        &ExceptionRequest {
            rule,
            subject_type: SubjectType::OrgChange,
            subject_id: request,
            reason_code: "SOLE_HOLDER",
            note: payload["reason"].as_str(),
            payload,
            affected_periods: &[],
            requested_by: actor,
            step_up_assertion_id: Some(assertion),
            other_eligible_holders: payload["other_eligible_holders"]
                .as_u64()
                .ok_or_else(invalid)?,
        },
        &settings,
    )
    .await
    .map_err(governance)?;
    consume_exception_conn(
        tx.as_mut(),
        exception.id,
        &GovernedWrite {
            rule,
            subject_type: SubjectType::OrgChange,
            subject_id: request,
            payload,
            affected_periods: &[],
        },
    )
    .await
    .map_err(governance)?;
    let recipients: Vec<Uuid> =
        serde_json::from_value(consent["recipients"].clone()).map_err(|_| invalid())?;
    sqlx::query("INSERT INTO notifications(org_id,recipient_user_id,category,body,link,dedup_key) SELECT NULLIF(current_setting('app.current_org',true),'')::uuid,recipient,'org_change.sole_holder',$2,jsonb_build_object('type','object','kind','org_change','id',$3::uuid::text),$4 FROM unnest($1::uuid[]) recipient ON CONFLICT(org_id,recipient_user_id,dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING")
    .bind(recipients).bind(payload["notice_template"].as_str().ok_or_else(invalid)?)
    .bind(request).bind(format!("org_change.sole_holder:{}",exception.id)).execute(tx.as_mut()).await.map_err(|_| invalid())?;
    Ok(exception.id)
}

fn governance(error: console_governance_adapter_postgres::PgGovernanceError) -> KernelError {
    match error {
        console_governance_adapter_postgres::PgGovernanceError::Domain(error) => error,
        console_governance_adapter_postgres::PgGovernanceError::Db(_) => {
            KernelError::internal("sole-holder exception could not be recorded")
        }
    }
}
