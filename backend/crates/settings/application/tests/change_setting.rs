//! Orchestration branches of `change_setting` over a tiny store fake: the
//! authorizer sees the direction and its refusal writes nothing; a refused
//! rule never reaches the authorizer or the store; a loosening waits out the
//! delay unless the tenant is onboarding. The rules themselves are covered in
//! the domain crate; the trigger in the adapter's DB tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{
    AuditRequestContext, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use console_settings_application::{
    Actor, ChangeFacts, ChangeSetting, InsertedOverride, NewOverride, SettingsStore, StoreFacts,
    change_setting,
};
use console_settings_domain::{Direction, OverrideRow, SettingKey};
use serde_json::json;
use time::{Duration, macros::datetime};
use uuid::Uuid;

const NOW: Timestamp = datetime!(2026-10-02 09:00 UTC);
const KEY: &str = "approval.delegation.max_days"; // 1..=90, default 30, higher is looser

#[derive(Default)]
struct Fake {
    onboarding: bool,
    inserted: Vec<NewOverride>,
}

impl SettingsStore for Fake {
    async fn facts(&mut self) -> Result<StoreFacts, KernelError> {
        Ok(StoreFacts {
            now: NOW,
            onboarding: self.onboarding,
        })
    }

    async fn validate_reason(
        &mut self,
        code: &str,
        note: Option<&str>,
    ) -> Result<console_settings_domain::code_lists::ValidReason, KernelError> {
        console_settings_domain::code_lists::validate_reason(
            console_settings_domain::code_lists::ReasonDomain::SettingsChange,
            code,
            note,
            &[],
        )
        .map_err(Into::into)
    }

    async fn resolve_step_up(
        &mut self,
        _actor: Actor,
        ceremony_id: Option<Uuid>,
        _scope_entity_id: Option<Uuid>,
        _key: SettingKey,
        _value: &console_settings_domain::SettingValue,
    ) -> Result<bool, KernelError> {
        Ok(ceremony_id.is_some())
    }

    async fn rows(
        &mut self,
        _key: SettingKey,
        _entity: Option<Uuid>,
    ) -> Result<Vec<OverrideRow>, KernelError> {
        Ok(Vec::new())
    }

    async fn insert(&mut self, row: NewOverride) -> Result<InsertedOverride, KernelError> {
        self.inserted.push(row);
        Ok(InsertedOverride {
            id: Uuid::nil(),
            direction: Direction::Tighten,
            onboarding_exempt: false,
        })
    }
}

fn cmd(value: serde_json::Value, effective_from: Option<Timestamp>) -> ChangeSetting {
    ChangeSetting {
        key: KEY.to_owned(),
        scope_entity_id: None,
        value,
        effective_from,
        reason_code: "POLICY_REVIEW".to_owned(),
        reason_note: None,
        step_up_assertion_id: None,
    }
}

fn actor() -> Actor {
    Actor {
        org: OrgId::one(),
        user: UserId::new(),
    }
}

async fn run(
    store: &mut Fake,
    change: ChangeSetting,
    seen: &mut Option<ChangeFacts>,
    allow: bool,
) -> Result<(), KernelError> {
    change_setting(
        store,
        |facts: &ChangeFacts| {
            *seen = Some(*facts);
            if allow {
                Ok(())
            } else {
                Err(KernelError::forbidden("denied"))
            }
        },
        actor(),
        change,
        (TraceContext::generate(), AuditRequestContext::default()),
    )
    .await
    .map(|(view, events)| {
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].target_id, view.id.to_string());
    })
}

#[tokio::test]
async fn a_tightening_is_authorized_with_its_direction_then_inserted_and_audited() {
    let mut store = Fake::default();
    let mut seen = None;
    run(&mut store, cmd(json!(20), None), &mut seen, true)
        .await
        .unwrap();
    assert_eq!(seen.unwrap().direction, Direction::Tighten);
    assert_eq!(store.inserted.len(), 1);
    assert_eq!(
        store.inserted[0].effective_from, NOW,
        "omitted = the store's now"
    );
}

#[tokio::test]
async fn an_authorizer_refusal_writes_nothing() {
    let mut store = Fake::default();
    let mut seen = None;
    let err = run(&mut store, cmd(json!(20), None), &mut seen, false)
        .await
        .unwrap_err();
    assert_eq!(err, KernelError::forbidden("denied"));
    assert!(store.inserted.is_empty());
}

#[tokio::test]
async fn a_broken_rule_never_reaches_the_authorizer_or_the_store() {
    let mut store = Fake::default();
    let mut seen = None;
    let err = run(&mut store, cmd(json!(91), None), &mut seen, true)
        .await
        .unwrap_err();
    assert_eq!(err.code, Some("setting_out_of_range"));
    assert!(seen.is_none());
    assert!(store.inserted.is_empty());

    let err = run(
        &mut store,
        ChangeSetting {
            key: "no.such.key".to_owned(),
            ..cmd(json!(1), None)
        },
        &mut seen,
        true,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, Some("setting_unknown_key"));
    assert_eq!(err.field.as_deref(), Some("key"));
}

#[tokio::test]
async fn a_loosening_waits_the_delay_unless_the_tenant_is_onboarding() {
    let mut store = Fake::default();
    let mut seen = None;
    let err = run(&mut store, cmd(json!(40), None), &mut seen, true)
        .await
        .unwrap_err();
    assert_eq!(err.code, Some("setting_loosening_delay"));

    let later = NOW + Duration::hours(24);
    run(&mut store, cmd(json!(40), Some(later)), &mut seen, true)
        .await
        .unwrap();
    assert_eq!(seen.unwrap().direction, Direction::Loosen);

    let mut onboarding = Fake {
        onboarding: true,
        ..Fake::default()
    };
    run(&mut onboarding, cmd(json!(40), None), &mut seen, true)
        .await
        .unwrap();
    assert_eq!(onboarding.inserted.len(), 1);
}

#[tokio::test]
async fn a_blank_reason_code_is_refused() {
    let mut store = Fake::default();
    let mut seen = None;
    let err = run(
        &mut store,
        ChangeSetting {
            reason_code: "  ".to_owned(),
            ..cmd(json!(20), None)
        },
        &mut seen,
        true,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, Some("reason_code_invalid"));
}
