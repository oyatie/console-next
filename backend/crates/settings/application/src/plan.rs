// SPDX-License-Identifier: LicenseRef-Proprietary
//! One validation and authorization path for previews and writes.
use crate::{Actor, ChangeFacts, ChangeSetting, NewOverride, SettingsStore};
use console_kernel_core::{KernelError, SettingVersionId, Timestamp};
use console_settings_domain::{
    Direction, LOOSENING_DELAY, SettingError, SettingKey, SettingValue, check_change, resolve_chain,
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
    Stale {
        error: KernelError,
        current_version: Option<SettingVersionId>,
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
    pub in_force: InForce,
    pub reaches: Reach,
}

#[derive(Debug, Clone, Serialize)]
pub struct InForce {
    pub value: Option<SettingValue>,
    pub version: Option<SettingVersionId>,
    pub scope_entity_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reach {
    pub scope_entity_id: Option<Uuid>,
    pub keeps_own_value: Vec<Uuid>,
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
    let (chain, rows) = store.rows(key, cmd.scope_entity_id).await?;
    let current = match resolve_chain(key, &rows, &chain, facts.now) {
        Ok(resolved) => Some(resolved),
        Err(SettingError::FactUndeclared(_)) => None,
        Err(other) => return Err(other.into()),
    };
    let current_version = current.map(|r| r.version);
    if cmd.expected_version.is_some() && cmd.expected_version != current_version {
        return Err(ChangeError::Stale {
            error: KernelError::conflict("the setting changed; reload its current value")
                .with_code("setting_version_stale")
                .with_field("expected_version"),
            current_version,
        });
    }
    let in_force = match resolve_chain(key, &rows, &chain, effective_from) {
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
        resource_entities: chain,
        key,
        direction: accepted.direction,
        step_up,
        step_up_assertion_id: cmd.step_up_assertion_id,
        scope_entity_id: cmd.scope_entity_id,
    })?;
    let source = current_version.and_then(|version| match version {
        SettingVersionId::Override(id) => rows
            .iter()
            .find(|r| r.id == id)
            .and_then(|r| r.scope_entity_id),
        SettingVersionId::CodeDefault => None,
    });
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
        in_force: InForce {
            value: current.map(|r| r.value),
            version: current_version,
            scope_entity_id: source,
        },
        reaches: Reach {
            scope_entity_id: cmd.scope_entity_id,
            keeps_own_value: store
                .keeps_own_value(key, cmd.scope_entity_id, effective_from)
                .await?,
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
