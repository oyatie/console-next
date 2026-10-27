// SPDX-License-Identifier: LicenseRef-Proprietary
//! One validation and authorization path for previews and writes.
use crate::{Actor, ChangeFacts, ChangeSetting, NewOverride, SettingsStore};
use console_kernel_core::{KernelError, Timestamp};
use console_settings_domain::{
    Direction, LOOSENING_DELAY, SettingError, SettingKey, SettingValue, check_change, resolve,
};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug)]
pub enum ChangeError {
    Refused(KernelError),
    TooSoon {
        error: KernelError,
        earliest: Timestamp,
    },
}

impl From<KernelError> for ChangeError {
    fn from(error: KernelError) -> Self {
        Self::Refused(error)
    }
}

impl From<SettingError> for ChangeError {
    fn from(error: SettingError) -> Self {
        match error {
            SettingError::LooseningTooSoon { earliest, .. } => Self::TooSoon {
                error: KernelError::conflict(error.to_string())
                    .with_code("setting_loosening_too_soon")
                    .with_field("effective_from"),
                earliest,
            },
            other => Self::Refused(other.into()),
        }
    }
}

// shortcut: version guards and reach metadata follow in S1b, before settings hub adoption.
#[derive(Debug, Clone, Serialize)]
pub struct SettingChangePlan {
    pub key: SettingKey,
    pub scope_entity_id: Option<Uuid>,
    pub value: SettingValue,
    #[serde(with = "time::serde::rfc3339")]
    pub effective_from: Timestamp,
    pub direction: Direction,
    pub path: &'static str,
    pub requires: Requirements,
    #[serde(with = "time::serde::rfc3339")]
    pub earliest_effective_from: Timestamp,
}

#[derive(Debug, Clone, Serialize)]
pub struct Requirements {
    pub reason: bool,
    pub step_up: bool,
    pub second_person: bool,
}

pub async fn plan_setting<S, A>(
    store: &mut S,
    authorize_change: A,
    actor: Actor,
    cmd: ChangeSetting,
    dry_run: bool,
) -> Result<(SettingChangePlan, NewOverride), ChangeError>
where
    S: SettingsStore + Send,
    A: FnOnce(&ChangeFacts) -> Result<(), KernelError> + Send,
{
    let key: SettingKey = cmd.key.parse().map_err(|_| crate::unknown_key(&cmd.key))?;
    let reason = store
        .validate_reason(&cmd.reason_code, cmd.reason_note.as_deref())
        .await?;
    let facts = store.facts().await?;
    let effective_from = cmd.effective_from.unwrap_or(facts.now);
    let rows = store.rows(key, cmd.scope_entity_id).await?;
    let in_force = match resolve(key, &rows, cmd.scope_entity_id, effective_from) {
        Ok(resolved) => Some(resolved.value),
        Err(SettingError::FactUndeclared(_)) => None,
        Err(other) => return Err(other.into()),
    };
    let accepted = check_change(
        key,
        &cmd.value,
        effective_from,
        facts.now,
        in_force,
        facts.onboarding,
    )?;
    let needs_step_up = accepted.direction == Direction::Loosen;
    let delayed = needs_step_up && !facts.onboarding;
    let step_up = dry_run
        || store
            .resolve_step_up(
                actor,
                cmd.step_up_assertion_id,
                cmd.scope_entity_id,
                key,
                &accepted.value,
            )
            .await?;
    authorize_change(&ChangeFacts {
        key,
        direction: accepted.direction,
        step_up,
        step_up_assertion_id: cmd.step_up_assertion_id,
        scope_entity_id: cmd.scope_entity_id,
    })?;
    let plan = SettingChangePlan {
        key,
        scope_entity_id: cmd.scope_entity_id,
        value: accepted.value,
        effective_from,
        direction: accepted.direction,
        path: if delayed {
            "step_up_delayed"
        } else if needs_step_up {
            "step_up"
        } else {
            "direct"
        },
        requires: Requirements {
            reason: true,
            step_up: needs_step_up,
            second_person: false,
        },
        earliest_effective_from: if delayed {
            facts.now + LOOSENING_DELAY
        } else {
            facts.now
        },
    };
    let row = NewOverride {
        key,
        scope_entity_id: cmd.scope_entity_id,
        value: accepted.value,
        effective_from,
        set_by: actor.user,
        reason_code: reason.code,
        reason_note: reason.note,
        step_up_assertion_id: if !dry_run && step_up {
            cmd.step_up_assertion_id
        } else {
            None
        },
        now: facts.now,
    };
    Ok((plan, row))
}
