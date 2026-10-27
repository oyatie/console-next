// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::{
    AuditRequestContext, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use console_settings_application::{
    Actor, ChangeError, ChangeSetting, InsertedOverride, NewOverride, SettingsStore, StoreFacts,
    change_setting, plan_setting,
};
use console_settings_domain::code_lists::{ReasonDomain, ValidReason, validate_reason};
use console_settings_domain::{Direction, LOOSENING_DELAY, OverrideRow, SettingKey, SettingValue};
use serde_json::{Value, json};
use time::{Duration, macros::datetime};
use uuid::Uuid;

const NOW: Timestamp = datetime!(2026-10-27 09:00 UTC);
#[derive(Default)]
struct Fake {
    rows: Vec<OverrideRow>,
    inserted: usize,
    step_up_reads: usize,
    onboarding: bool,
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
    ) -> Result<ValidReason, KernelError> {
        validate_reason(ReasonDomain::SettingsChange, code, note, &[]).map_err(Into::into)
    }
    async fn resolve_step_up(
        &mut self,
        _: Actor,
        _: Option<Uuid>,
        _: Option<Uuid>,
        _: SettingKey,
        _: &SettingValue,
    ) -> Result<bool, KernelError> {
        self.step_up_reads += 1;
        Ok(false)
    }
    async fn rows(
        &mut self,
        _: SettingKey,
        _: Option<Uuid>,
    ) -> Result<Vec<OverrideRow>, KernelError> {
        Ok(self.rows.clone())
    }
    async fn insert(
        &mut self,
        _: NewOverride,
    ) -> Result<InsertedOverride, console_settings_application::ChangeError> {
        self.inserted += 1;
        Ok(InsertedOverride {
            id: Uuid::new_v4(),
            direction: Direction::Tighten,
            onboarding_exempt: false,
        })
    }
}
fn actor() -> Actor {
    Actor {
        org: OrgId::one(),
        user: UserId::new(),
    }
}
fn cmd(value: Value) -> ChangeSetting {
    ChangeSetting {
        key: "approval.delegation.max_days".into(),
        scope_entity_id: None,
        value,
        effective_from: None,
        reason_code: "POLICY_REVIEW".into(),
        reason_note: None,
        step_up_assertion_id: None,
    }
}
fn refused(error: ChangeError) -> KernelError {
    match error {
        ChangeError::Refused(e) | ChangeError::TooSoon { error: e, .. } => e,
    }
}

#[tokio::test]
async fn dry_run_inserts_nothing_and_audits_nothing() {
    let mut store = Fake::default();
    let (plan, _) = plan_setting(&mut store, |_| Ok(()), actor(), cmd(json!(20)), true)
        .await
        .unwrap();
    assert_eq!(plan.path, "direct");
    assert_eq!(store.inserted, 0);
    assert_eq!(store.step_up_reads, 0);
}

#[tokio::test]
async fn dry_run_refusal_equals_write_refusal() {
    let mut backdated = cmd(json!(20));
    backdated.effective_from = Some(NOW - Duration::seconds(1));
    let mut unknown = cmd(json!(20));
    unknown.key = "no.such.key".into();
    for (change, code) in [
        (cmd(json!(91)), "setting_out_of_range"),
        (backdated, "setting_backdated"),
        (cmd(json!(40)), "setting_loosening_too_soon"),
        (cmd(json!("bad")), "setting_value_invalid"),
        (unknown, "setting_unknown_key"),
    ] {
        let mut store = Fake::default();
        let preview = refused(
            plan_setting(&mut store, |_| Ok(()), actor(), change.clone(), true)
                .await
                .unwrap_err(),
        );
        let write = refused(
            change_setting(
                &mut store,
                |_| Ok(()),
                actor(),
                change,
                (TraceContext::generate(), AuditRequestContext::default()),
            )
            .await
            .unwrap_err(),
        );
        assert_eq!(preview.code, Some(code));
        assert_eq!(preview, write);
        assert_eq!(store.inserted, 0);
    }
    for code in ["out_of_scope", "scope_tenant_wide_only", "forbidden"] {
        let mut store = Fake::default();
        let deny = |_: &_| Err(KernelError::forbidden("denied").with_code(code));
        let preview = refused(
            plan_setting(&mut store, deny, actor(), cmd(json!(20)), true)
                .await
                .unwrap_err(),
        );
        let write = refused(
            change_setting(
                &mut store,
                deny,
                actor(),
                cmd(json!(20)),
                (TraceContext::generate(), AuditRequestContext::default()),
            )
            .await
            .unwrap_err(),
        );
        assert_eq!(preview.code, Some(code));
        assert_eq!(preview, write);
    }
}

#[tokio::test]
async fn loosen_reports_step_up_delayed_with_earliest() {
    let mut change = cmd(json!(40));
    change.effective_from = Some(NOW + LOOSENING_DELAY);
    let (plan, _) = plan_setting(
        &mut Fake::default(),
        |facts| {
            assert!(facts.step_up);
            Ok(())
        },
        actor(),
        change.clone(),
        true,
    )
    .await
    .unwrap();
    assert_eq!(plan.path, "step_up_delayed");
    assert_eq!(plan.earliest_effective_from, NOW + LOOSENING_DELAY);
    assert!(plan.requires.reason && plan.requires.step_up && !plan.requires.second_person);
    let error = change_setting(
        &mut Fake::default(),
        |facts| {
            assert!(!facts.step_up);
            Err(KernelError::forbidden("step-up").with_code("step_up_required"))
        },
        actor(),
        change,
        (TraceContext::generate(), AuditRequestContext::default()),
    )
    .await
    .unwrap_err();
    assert_eq!(refused(error).code, Some("step_up_required"));
}

#[tokio::test]
async fn onboarding_and_neutral_report_only_current_enforcement() {
    for (onboarding, value, path, step_up) in
        [(true, 40, "step_up", true), (false, 30, "direct", false)]
    {
        let (plan, _) = plan_setting(
            &mut Fake {
                onboarding,
                ..Fake::default()
            },
            |_| Ok(()),
            actor(),
            cmd(json!(value)),
            true,
        )
        .await
        .unwrap();
        assert_eq!(plan.path, path);
        assert_eq!(plan.requires.step_up, step_up);
        assert_eq!(plan.earliest_effective_from, NOW);
    }
}
