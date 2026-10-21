//! Settings registry use cases (BW-00, decisions D0.3).
//!
//! One use case, [`change_setting`]: load the facts the change rules need
//! from the store, run the domain check, let the caller's authorizer decide
//! who may (Cedar, with the change direction as a fact), insert the row and
//! return the audit event. Reads (resolved values, history) make no decision,
//! so they are facade queries on the adapter, not use cases (ADR-002 §6).
//!
//! Layer: application. Depends on the settings domain and the kernel; no IO.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod reason_codes;

use console_kernel_core::{
    AuditAction, AuditEvent, AuditRequestContext, KernelError, OrgId, Timestamp, TraceContext,
    UserId,
};
use console_settings_domain::code_lists::ValidReason;
use console_settings_domain::{
    Direction, OverrideRow, SettingError, SettingKey, SettingValue, check_change, resolve,
};
use serde::Serialize;
use std::future::Future;
use uuid::Uuid;

/// The audit action recorded for every accepted change.
pub const SETTING_CHANGE_AUDIT_ACTION: &str = "settings.override_insert";

/// Facts the store reads at the start of the change, from the database's
/// clock, so the domain check and the `BEFORE INSERT` trigger see one `now`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreFacts {
    pub now: Timestamp,
    /// D0.3 onboarding: no employees and no applied payroll run.
    pub onboarding: bool,
}

/// A row to insert. `now` is [`StoreFacts::now`], used only to report the
/// earliest allowed time if the trigger refuses a loosening.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewOverride {
    pub key: SettingKey,
    pub scope_entity_id: Option<Uuid>,
    pub value: SettingValue,
    pub effective_from: Timestamp,
    pub set_by: UserId,
    pub reason_code: String,
    pub reason_note: Option<String>,
    pub step_up_assertion_id: Option<Uuid>,
    pub now: Timestamp,
}

/// What the trigger recorded for the inserted row (it is the authority).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InsertedOverride {
    pub id: Uuid,
    pub direction: Direction,
    pub onboarding_exempt: bool,
}

/// The output port, implemented once on the adapter's transaction wrapper.
pub trait SettingsStore {
    fn facts(&mut self) -> impl Future<Output = Result<StoreFacts, KernelError>> + Send;

    fn validate_reason(
        &mut self,
        code: &str,
        note: Option<&str>,
    ) -> impl Future<Output = Result<ValidReason, KernelError>> + Send;

    fn resolve_step_up(
        &mut self,
        actor: Actor,
        ceremony_id: Option<Uuid>,
        scope_entity_id: Option<Uuid>,
        key: SettingKey,
        value: &SettingValue,
    ) -> impl Future<Output = Result<bool, KernelError>> + Send;

    /// Every row of `key` at the tenant scope and, when given, at `entity`.
    fn rows(
        &mut self,
        key: SettingKey,
        entity: Option<Uuid>,
    ) -> impl Future<Output = Result<Vec<OverrideRow>, KernelError>> + Send;

    fn insert(
        &mut self,
        row: NewOverride,
    ) -> impl Future<Output = Result<InsertedOverride, KernelError>> + Send;
}

/// The request to change one setting.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeSetting {
    /// The wire key, as the caller sent it.
    pub key: String,
    pub scope_entity_id: Option<Uuid>,
    pub value: serde_json::Value,
    /// `None` = now.
    pub effective_from: Option<Timestamp>,
    pub reason_code: String,
    pub reason_note: Option<String>,
    pub step_up_assertion_id: Option<Uuid>,
}

/// Who acts, and the request trace for the audit row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Actor {
    pub org: OrgId,
    pub user: UserId,
}

/// The facts the authorizer (Cedar `settings_change`) decides on. Loosening
/// requires a fresh step-up; that is Cedar's rule, not this crate's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChangeFacts {
    pub key: SettingKey,
    pub direction: Direction,
    pub step_up: bool,
    pub step_up_assertion_id: Option<Uuid>,
    pub scope_entity_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingChangeView {
    pub id: Uuid,
    pub key: SettingKey,
    pub scope_entity_id: Option<Uuid>,
    pub value: SettingValue,
    #[serde(with = "time::serde::rfc3339")]
    pub effective_from: Timestamp,
    pub direction: Direction,
    pub onboarding_exempt: bool,
}

/// Changes one setting: check, authorize, insert, audit.
///
/// # Errors
/// - `setting_unknown_key` (422) for a key the roster does not have;
/// - a coded [`SettingError`] for the first change rule the request breaks;
/// - whatever `authorize` refuses with (fail closed);
/// - store errors as they come.
pub async fn change_setting<S, A>(
    store: &mut S,
    authorize: A,
    actor: Actor,
    cmd: ChangeSetting,
    (trace, request): (TraceContext, AuditRequestContext),
) -> Result<(SettingChangeView, Vec<AuditEvent>), KernelError>
where
    S: SettingsStore + Send,
    A: FnOnce(&ChangeFacts) -> Result<(), KernelError> + Send,
{
    let key: SettingKey = cmd.key.parse().map_err(|_| unknown_key(&cmd.key))?;
    let valid_reason = store
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
    let step_up = store
        .resolve_step_up(
            actor,
            cmd.step_up_assertion_id,
            cmd.scope_entity_id,
            key,
            &accepted.value,
        )
        .await?;
    authorize(&ChangeFacts {
        key,
        direction: accepted.direction,
        step_up,
        step_up_assertion_id: cmd.step_up_assertion_id,
        scope_entity_id: cmd.scope_entity_id,
    })?;
    let step_up_assertion_id = if step_up {
        cmd.step_up_assertion_id
    } else {
        None
    };
    let inserted = store
        .insert(NewOverride {
            key,
            scope_entity_id: cmd.scope_entity_id,
            value: accepted.value,
            effective_from,
            set_by: actor.user,
            reason_code: valid_reason.code.clone(),
            reason_note: valid_reason.note,
            step_up_assertion_id,
            now: facts.now,
        })
        .await?;
    let view = SettingChangeView {
        id: inserted.id,
        key,
        scope_entity_id: cmd.scope_entity_id,
        value: accepted.value,
        effective_from,
        direction: inserted.direction,
        onboarding_exempt: inserted.onboarding_exempt,
    };
    // the D0.3 loosening notice (every EXECUTIVE/SUPER_ADMIN and the
    // security contact) is not sent here; `direction` on this audit row is
    // what it keys on. Add with BW-29's security-contact channel.
    let mut after =
        serde_json::to_value(&view).map_err(|e| KernelError::internal(e.to_string()))?;
    after["reason_code"] = valid_reason.code.into();
    after["step_up_assertion_id"] = serde_json::json!(step_up_assertion_id);
    let event = AuditEvent::new(
        Some(actor.user),
        AuditAction::new(SETTING_CHANGE_AUDIT_ACTION)?,
        "tenant_setting_override",
        view.id.to_string(),
        trace,
        facts.now,
    )
    .with_org(actor.org)
    .with_request_context(request)
    .with_snapshots(None, Some(after));
    Ok((view, vec![event]))
}

fn unknown_key(raw: &str) -> KernelError {
    KernelError::validation(format!("unknown setting key: {raw}"))
        .with_code("setting_unknown_key")
        .with_field("key")
}
