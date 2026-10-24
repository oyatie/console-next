// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    PgEntityError, PgEntityStore, admit, audit, command::claim, registration_check::failure,
};
use console_entity_application::{
    Actor,
    registration_check::{CheckAnswer, CheckKind, RegistrationCheck, UserValidation},
};
use console_entity_domain::Refusal;
use console_kernel_core::WriteClass;
use console_platform_db::with_audits;
use serde_json::json;
use std::sync::Arc;

impl PgEntityStore {
    /// Explicit, idempotent user action while typing a certificate; never required for saving.
    /// # Errors
    /// Invalid typed fields, unavailable provider, rate limit or database faults.
    pub async fn preview_registration_check(
        &self,
        actor: &Actor,
        kind: CheckKind,
        values: UserValidation,
        port: Arc<dyn RegistrationCheck>,
    ) -> Result<CheckAnswer, PgEntityError> {
        let actor = actor.clone();
        let refusal_actor = actor.clone();
        let result = with_audits(&self.pool,actor.org,move |tx| Box::pin(async move {
            if claim(tx,&actor,"business_registration.check_preview",json!({"kind":kind,"values":values})).await?.is_some() {
                let value: serde_json::Value = sqlx::query_scalar("SELECT outcome->'preview' FROM entity_commands WHERE command_id=$1").bind(actor.command_id).fetch_one(tx.as_mut()).await?;
                return Ok((serde_json::from_value(value)?,vec![]));
            }
            if values.brn.len()!=10 || !values.brn.bytes().all(|b| b.is_ascii_digit()) { return Err(Refusal::field("brn","brn_length").into()); }
            if kind == CheckKind::Validate {
                let mut issues=console_entity_domain::Issues::default();
                issues.date("opened_on",Some(&values.opened_on),true,Some(crate::today_kst(tx).await?));
                issues.text("representative",Some(&values.representative),100,true);
                issues.finish_opt(||Some(()))?;
            }
            let admitted=admit(tx,WriteClass::EntityStructure).await?;
            let answer=match kind {
                CheckKind::Status => port.status(std::slice::from_ref(&values.brn)).await.map_err(failure)?.into_iter().next().ok_or_else(|| Refusal::conflict("registration_check_unavailable","provider response missing"))?,
                CheckKind::Validate => port.validate(&values).await.map_err(failure)?,
            };
            sqlx::query("UPDATE entity_commands SET outcome=$2 WHERE command_id=$1").bind(actor.command_id).bind(json!({"preview":answer,"checked_at":time::OffsetDateTime::now_utc().to_string()})).execute(tx.as_mut()).await?;
            let event=audit(&actor,"business_registration.check_preview","business_registration_preview",actor.command_id.ok_or_else(|| Refusal::field("Idempotency-Key","required"))?,admitted,json!({"kind":kind,"fields_sent":answer.fields_sent,"purpose":"registration_evidence"}))?;
            Ok((answer,vec![event]))
        })).await;
        crate::registration_check::audit_failure(
            self,
            &refusal_actor,
            refusal_actor
                .command_id
                .unwrap_or(*refusal_actor.org.as_uuid()),
            kind,
            result,
        )
        .await
    }
}

pub(crate) async fn accepted_preview(
    tx: &mut crate::Tx<'_>,
    actor: &Actor,
    entity: uuid::Uuid,
    preview: Option<&console_entity_application::registration_check::PreviewAcceptance>,
    number: Option<&str>,
    opened_on: time::Date,
) -> Result<Option<CheckAnswer>, PgEntityError> {
    let Some(preview) = preview else {
        return Ok(None);
    };
    let value: Option<serde_json::Value> = sqlx::query_scalar("SELECT outcome->'preview' FROM entity_commands WHERE command_id=$1 AND actor_id=$2 AND action='business_registration.check_preview'").bind(preview.command_id).bind(*actor.user.as_uuid()).fetch_optional(tx.as_mut()).await?;
    let answer: CheckAnswer = serde_json::from_value(
        value.ok_or_else(|| Refusal::field("check_preview", "invalid_option"))?,
    )?;
    if number != Some(answer.brn_checked.as_str()) {
        return Err(Refusal::field("check_preview", "invalid_option").into());
    }
    if matches!(
        answer.reported_status,
        Some(
            console_entity_domain::codes::OperatingStatus::Suspended
                | console_entity_domain::codes::OperatingStatus::Closed
        )
    ) && !preview.acknowledged
    {
        return Err(Refusal::field("check_preview.acknowledged", "required").into());
    }
    if answer.kind == CheckKind::Validate {
        let entity = crate::legal_entity::one(tx, entity, None, true).await?;
        let representative = entity
            .current
            .and_then(|c| c.representatives)
            .and_then(|r| r.into_iter().next())
            .unwrap_or_default();
        let request = json!({"action":"business_registration.check_preview","request":{"kind":answer.kind,"values":{"brn":number,"opened_on":opened_on.to_string(),"representative":representative}}});
        let same: bool=sqlx::query_scalar("SELECT request_digest=sha256(convert_to($2::jsonb::text,'UTF8')) FROM entity_commands WHERE command_id=$1").bind(preview.command_id).bind(request).fetch_one(tx.as_mut()).await?;
        if !same {
            return Err(Refusal::field("check_preview", "invalid_option").into());
        }
    }
    Ok(Some(answer))
}

pub(crate) fn initial_status_since(
    answer: Option<&CheckAnswer>,
    acceptance: Option<&console_entity_application::registration_check::PreviewAcceptance>,
    today: time::Date,
) -> Result<Option<time::Date>, PgEntityError> {
    use console_entity_domain::codes::OperatingStatus;
    match answer.and_then(|a| a.reported_status) {
        Some(OperatingStatus::Closed) => {
            let date = answer
                .and_then(|a| a.end_dt.as_deref())
                .and_then(|d| {
                    time::Date::parse(d, time::macros::format_description!("[year][month][day]"))
                        .ok()
                })
                .ok_or_else(|| Refusal::field("check_preview", "invalid_option"))?;
            Ok(Some(date))
        }
        Some(OperatingStatus::Suspended) => {
            let mut issues = console_entity_domain::Issues::default();
            let date = issues.date(
                "check_preview.status_since",
                acceptance.and_then(|p| p.status_since.as_deref()),
                true,
                Some(today),
            );
            Ok(Some(issues.finish_opt(|| date)?))
        }
        _ => Ok(None),
    }
}
