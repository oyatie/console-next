// SPDX-License-Identifier: LicenseRef-Proprietary
//! Read before disclosure, then re-read under the short evidence-write transaction.
use crate::{PgEntityError, Tx};
use console_entity_application::{
    Actor,
    registration_check::{CheckKind, UserValidation},
};
use console_entity_domain::Refusal;
use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) enum Prepared {
    Replay(console_entity_application::registration_check::CheckEvidence),
    Current(UserValidation),
}

pub(crate) async fn completed(
    tx: &mut Tx<'_>,
    actor: &Actor,
    action: &str,
    request: Value,
) -> Result<Option<Value>, PgEntityError> {
    let id = crate::command::command_id(actor)?;
    let saved: Option<(bool, Value)> = sqlx::query_as("SELECT action=$2 AND request_digest=sha256(convert_to($3::jsonb::text,'UTF8')),outcome FROM entity_commands WHERE command_id=$1")
        .bind(id).bind(action).bind(json!({"action":action,"request":request})).fetch_optional(tx.as_mut()).await?;
    match saved {
        Some((false, _)) => Err(Refusal::conflict(
            "idempotency_key_reused",
            "this Idempotency-Key was already used for a different request",
        )
        .with_remedy("retry_with_new_key")
        .into()),
        Some((true, value)) => Ok(Some(value)),
        None => Ok(None),
    }
}

pub(crate) async fn values(
    tx: &mut Tx<'_>,
    actor: &Actor,
    id: Uuid,
    pack: &str,
    kind: CheckKind,
    lock: bool,
) -> Result<UserValidation, PgEntityError> {
    let (entity, brn) = crate::registration_check::subject(tx, id, pack, lock).await?;
    let mut values = UserValidation {
        brn,
        opened_on: String::new(),
        representative: String::new(),
    };
    if kind == CheckKind::Validate {
        let e = crate::legal_entity::one(tx, entity, actor.scope.granted(), true).await?;
        let r = e
            .registrations
            .iter()
            .find(|r| r.id == id)
            .and_then(|r| r.current.as_ref())
            .ok_or_else(|| Refusal::field("opened_on", "required"))?;
        values.opened_on = r
            .opened_on
            .ok_or_else(|| Refusal::field("opened_on", "required"))?
            .to_string();
        values.representative = e
            .current
            .and_then(|c| c.representatives)
            .and_then(|r| r.into_iter().next())
            .ok_or_else(|| Refusal::field("representatives", "required"))?;
    }
    Ok(values)
}

pub(crate) fn confirm(
    expected: &UserValidation,
    current: &UserValidation,
) -> Result<(), PgEntityError> {
    if expected.brn != current.brn
        || expected.opened_on != current.opened_on
        || expected.representative != current.representative
    {
        return Err(Refusal::conflict(
            "stale_revision",
            "the confirmed registration values changed",
        )
        .with_remedy("reload_and_reapply")
        .into());
    }
    Ok(())
}

pub(crate) async fn call(
    port: &dyn console_entity_application::registration_check::RegistrationCheck,
    kind: CheckKind,
    values: &UserValidation,
) -> Result<console_entity_application::registration_check::CheckAnswer, PgEntityError> {
    use crate::registration_check::failure;
    match kind {
        CheckKind::Status => port
            .status(std::slice::from_ref(&values.brn))
            .await
            .map_err(failure)?
            .into_iter()
            .find(|a| a.brn_checked == values.brn)
            .ok_or_else(|| {
                failure(
                    console_entity_application::registration_check::CheckFailure::Contract {
                        code: "missing_answer",
                    },
                )
            }),
        CheckKind::Validate => port.validate(values).await.map_err(failure),
    }
}
