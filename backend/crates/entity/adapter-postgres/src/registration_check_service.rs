// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::command::{Outcome, claim, finish};
use crate::registration_check::{append, evidence, failure, reconcile, subject};
use crate::{PgEntityError, PgEntityStore, admit, audit};
use console_entity_application::{
    Actor,
    registration_check::{
        CheckEvidence, CheckHistory, CheckKind, RegistrationCheck, RegistrationCheckInbox,
        RegistrationCheckItem, UserValidation,
    },
};
use console_entity_domain::Refusal;
use console_kernel_core::{KernelError, WriteClass};
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use std::sync::Arc;
use uuid::Uuid;

impl PgEntityStore {
    /// # Errors
    /// Number/void, authority availability, rate-limit refusals or database failures.
    pub async fn check_registration(
        &self,
        actor: &Actor,
        id: Uuid,
        kind: CheckKind,
        port: Arc<dyn RegistrationCheck>,
    ) -> Result<CheckEvidence, PgEntityError> {
        self.check_registration_expected(actor, id, kind, None, port)
            .await
    }

    /// Verify the values confirmed by the user before disclosing them externally.
    /// # Errors
    /// As check, plus stale_revision when confirmed values changed.
    pub async fn check_registration_expected(
        &self,
        actor: &Actor,
        id: Uuid,
        kind: CheckKind,
        expected: Option<UserValidation>,
        port: Arc<dyn RegistrationCheck>,
    ) -> Result<CheckEvidence, PgEntityError> {
        let actor = actor.clone();
        let refusal_actor = actor.clone();
        let result = with_audits(&self.pool, actor.org, move |tx| Box::pin(async move {
            if let Some(done) = claim(tx, &actor, "business_registration.check", json!({"id":id,"kind":kind,"expected":expected})).await? {
                return Ok((evidence(tx, done.target.ok_or_else(|| Refusal::not_found("registration_not_found"))?, port.reflection_lag_days()).await?, vec![]));
            }
            let (entity, brn) = subject(tx, id, port.pack()).await?;
            let admitted = admit(tx, WriteClass::EntityStructure).await?;
            let answer = match kind {
                CheckKind::Status => port.status(std::slice::from_ref(&brn)).await.map_err(failure)?.into_iter().find(|a| a.brn_checked == brn).ok_or_else(|| failure(console_entity_application::registration_check::CheckFailure::Contract { code: "missing_answer" }))?,
                CheckKind::Validate => {
                    let e = crate::legal_entity::one(tx, entity, actor.scope.granted(), true).await?;
                    let r = e.registrations.iter().find(|r| r.id == id).and_then(|r| r.current.as_ref()).ok_or_else(|| Refusal::field("opened_on", "required"))?;
                    let opened_on = r.opened_on.ok_or_else(|| Refusal::field("opened_on", "required"))?.to_string();
                    let representative = e.current.and_then(|c| c.representatives).and_then(|r| r.into_iter().next()).ok_or_else(|| Refusal::field("representatives", "required"))?;
                    if expected.as_ref().is_some_and(|v| v.brn != brn || v.opened_on != opened_on || v.representative != representative) {
                        return Err(Refusal::conflict("stale_revision","the confirmed registration values changed").with_remedy("reload_and_reapply").into());
                    }
                    port.validate(&UserValidation { brn, opened_on, representative }).await.map_err(failure)?
                }
            };
            let check_id = append(tx, id, Some(*actor.user.as_uuid()), &answer, None).await?;
            reconcile(tx, id, port.reflection_lag_days()).await?;
            finish(tx, &actor, &Outcome { target: Some(check_id), ..Outcome::default() }).await?;
            let event = audit(&actor, "business_registration.check", "business_registration", id, admitted,
                json!({"check_id": check_id,"kind":kind,"fields_sent":answer.fields_sent,"purpose":"registration_evidence"}))?;
            Ok((evidence(tx, check_id, port.reflection_lag_days()).await?, vec![event]))
        })).await;
        crate::registration_check::audit_failure(self, &refusal_actor, id, kind, result).await
    }

    /// # Errors
    /// Unknown/out-of-scope registration or database failure.
    pub async fn registration_checks(
        &self,
        actor: &Actor,
        id: Uuid,
        limit: i64,
        before: Option<Uuid>,
    ) -> Result<CheckHistory, PgEntityError> {
        let actor = actor.clone();
        with_org_conn(&self.pool, actor.org, move |tx| Box::pin(async move {
            let allowed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM business_registrations r WHERE id=$1 AND ($2::uuid[] IS NULL OR legal_entity_id=ANY($2)))").bind(id).bind(actor.scope.granted()).fetch_one(tx.as_mut()).await?;
            if !allowed { return Err(Refusal::not_found("registration_not_found").into()); }
            let limit = limit.clamp(1, 100);
            let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM business_registration_checks WHERE registration_id=$1 AND ($2::uuid IS NULL OR (checked_at,id)<(SELECT checked_at,id FROM business_registration_checks WHERE id=$2 AND registration_id=$1)) ORDER BY checked_at DESC,id DESC LIMIT $3")
                .bind(id).bind(before).bind(limit + 1).fetch_all(tx.as_mut()).await?;
            let mut items = Vec::new();
            for check_id in ids.iter().take(usize::try_from(limit).unwrap_or(100)) { items.push(evidence(tx, *check_id, crate::registration_check_schedule::CheckSchedulePolicy::default().reflection_lag_days).await?); }
            let latest: Vec<Uuid> = sqlx::query_scalar("SELECT DISTINCT ON(c.kind) c.id FROM business_registration_checks c JOIN business_registrations r ON r.id=c.registration_id AND r.brn=c.brn_checked WHERE r.id=$1 ORDER BY c.kind,c.checked_at DESC,c.id DESC").bind(id).fetch_all(tx.as_mut()).await?;
            let mut latest_status = None;
            let mut latest_validate = None;
            for check_id in latest {
                let check = evidence(tx, check_id, crate::registration_check_schedule::CheckSchedulePolicy::default().reflection_lag_days).await?;
                match check.answer.kind { CheckKind::Status => latest_status=Some(check), CheckKind::Validate => latest_validate=Some(check) }
            }
            Ok(CheckHistory { next_cursor: (ids.len() > usize::try_from(limit).unwrap_or(100)).then(|| items.last().map(|i| i.id)).flatten(), items, latest_status, latest_validate })
        })).await
    }

    /// Source contract for the action inbox consumer; respects the caller's entity scope.
    /// # Errors
    /// Database failures.
    pub async fn registration_check_items(
        &self,
        actor: &Actor,
    ) -> Result<Vec<RegistrationCheckItem>, PgEntityError> {
        let actor = actor.clone();
        with_org_conn(&self.pool, actor.org, move |tx| Box::pin(async move {
            let rows: Vec<(Uuid,Uuid,Uuid,time::OffsetDateTime)> = sqlx::query_as("SELECT i.id,i.registration_id,r.legal_entity_id,i.created_at FROM business_registration_check_items i JOIN business_registrations r ON r.id=i.registration_id JOIN business_registration_checks c ON c.id=i.check_id AND c.brn_checked=r.brn WHERE i.closed_at IS NULL AND r.voided_at IS NULL AND ($1::uuid[] IS NULL OR r.legal_entity_id=ANY($1)) ORDER BY i.created_at,i.id")
                .bind(actor.scope.granted()).fetch_all(tx.as_mut()).await?;
            Ok(rows.into_iter().map(|(id,registration_id,legal_entity_id,created_at)| RegistrationCheckItem {id,registration_id,legal_entity_id,created_at}).collect())
        })).await
    }
}
impl RegistrationCheckInbox for PgEntityStore {
    fn list_check_items<'a>(
        &'a self,
        actor: &'a Actor,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<Vec<RegistrationCheckItem>, KernelError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.registration_check_items(actor)
                .await
                .map_err(|_| KernelError::internal("registration check inbox unavailable"))
        })
    }
}
