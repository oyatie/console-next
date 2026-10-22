//! Orchestration of the catalog admin use cases over a tiny store fake: a
//! refused check never reaches the authorizer or the store, an authorizer
//! refusal writes nothing, and an accepted change is audited. The checks
//! themselves are covered in the domain crate; the SQL in the adapter's DB
//! tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{
    AuditRequestContext, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use console_settings_application::Actor;
use console_settings_application::reason_codes::{
    AddReasonCode, ReasonCodeStore, TenantCodeView, UpdateReasonCode, add_reason_code,
    update_reason_code,
};
use console_settings_domain::code_lists::{NewTenantCode, ReasonDomain};
use time::macros::datetime;
use uuid::Uuid;

#[derive(Default)]
struct Fake {
    writes: usize,
}

fn view(code: &str, active: bool) -> TenantCodeView {
    TenantCodeView {
        domain: ReasonDomain::PeriodUnlock,
        code: code.to_owned(),
        label_ko: "라벨".to_owned(),
        label_en: None,
        requires_note: false,
        involuntary: false,
        notice_required: false,
        active,
        sort: 0,
    }
}

impl ReasonCodeStore for Fake {
    async fn now(&mut self) -> Result<Timestamp, KernelError> {
        Ok(datetime!(2026-10-02 09:00 UTC))
    }

    async fn insert(
        &mut self,
        code: &NewTenantCode,
        _sort: i32,
        _by: Actor,
    ) -> Result<TenantCodeView, KernelError> {
        self.writes += 1;
        Ok(TenantCodeView {
            domain: code.domain,
            involuntary: code.involuntary,
            notice_required: code.notice_required,
            ..view(&code.code, true)
        })
    }

    async fn update(
        &mut self,
        _domain: ReasonDomain,
        code: &str,
        active: Option<bool>,
        _sort: Option<i32>,
    ) -> Result<Option<(TenantCodeView, TenantCodeView)>, KernelError> {
        self.writes += 1;
        Ok(Some((view(code, true), view(code, active.unwrap_or(true)))))
    }
}

fn actor() -> Actor {
    Actor {
        org: OrgId::from_uuid(Uuid::new_v4()),
        user: UserId::from_uuid(Uuid::new_v4()),
    }
}

fn audit() -> (TraceContext, AuditRequestContext) {
    (TraceContext::generate(), AuditRequestContext::default())
}

fn add(domain: &str, label: &str) -> AddReasonCode {
    AddReasonCode {
        domain: domain.to_owned(),
        label_ko: label.to_owned(),
        label_en: None,
        requires_note: false,
        involuntary: false,
        notice_required: false,
        sort: None,
    }
}

fn update(code: &str, active: Option<bool>) -> UpdateReasonCode {
    UpdateReasonCode {
        domain: "period_unlock".to_owned(),
        code: code.to_owned(),
        active,
        sort: None,
    }
}

fn never(_: ReasonDomain) -> Result<(), KernelError> {
    panic!("a refused check must not reach the authorizer")
}

fn coded<T: std::fmt::Debug>(result: Result<T, KernelError>) -> &'static str {
    result.unwrap_err().code.expect("coded refusal")
}

#[tokio::test]
async fn refused_checks_never_reach_the_authorizer_or_the_store() {
    let mut store = Fake::default();
    let bad_domain =
        add_reason_code(&mut store, never, actor(), add("nope", "라벨"), audit()).await;
    assert_eq!(coded(bad_domain), "reason_domain_invalid");
    let blank = add_reason_code(
        &mut store,
        never,
        actor(),
        add("period_unlock", " "),
        audit(),
    )
    .await;
    assert_eq!(coded(blank), "reason_label_invalid");
    let empty = update_reason_code(&mut store, never, actor(), update("T_X", None), audit()).await;
    assert_eq!(coded(empty), "reason_code_update_empty");
    let system = update_reason_code(
        &mut store,
        never,
        actor(),
        update("OTHER", Some(false)),
        audit(),
    )
    .await;
    assert_eq!(coded(system), "reason_code_system");
    assert_eq!(store.writes, 0);
}

#[tokio::test]
async fn an_authorizer_refusal_writes_nothing() {
    let mut store = Fake::default();
    let deny = |_: ReasonDomain| Err(KernelError::forbidden("no"));
    let added = add_reason_code(
        &mut store,
        deny,
        actor(),
        add("period_unlock", "라벨"),
        audit(),
    )
    .await;
    assert!(added.is_err());
    let code = format!("T_{:X}", Uuid::new_v4().simple());
    let toggled = update_reason_code(
        &mut store,
        deny,
        actor(),
        update(&code, Some(false)),
        audit(),
    )
    .await;
    assert!(toggled.is_err());
    assert_eq!(store.writes, 0);
}

#[tokio::test]
async fn an_accepted_change_is_audited_with_before_and_after() {
    let mut store = Fake::default();
    let seen = std::sync::Mutex::new(None);
    let (view, events) = add_reason_code(
        &mut store,
        |d| {
            *seen.lock().unwrap() = Some(d);
            Ok(())
        },
        actor(),
        add("period_unlock", " 라벨 "),
        audit(),
    )
    .await
    .unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(ReasonDomain::PeriodUnlock));
    assert!(view.code.starts_with("T_"));
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action.as_str(), "reason_codes.add");
    assert_eq!(events[0].target_id, format!("period_unlock/{}", view.code));

    let (after, events) = update_reason_code(
        &mut store,
        |_| Ok(()),
        actor(),
        update(&view.code, Some(false)),
        audit(),
    )
    .await
    .unwrap();
    assert!(!after.active);
    assert_eq!(events[0].before.as_ref().unwrap()["active"], true);
    assert_eq!(events[0].after.as_ref().unwrap()["active"], false);
}

#[tokio::test]
async fn invalid_reason_classes_refuse_before_authorization_or_storage() {
    for (domain, involuntary, notice_required) in [
        ("exit_reason", false, true),
        ("lifecycle_transfer", true, false),
        ("lifecycle_transfer", true, true),
    ] {
        let mut store = Fake::default();
        let cmd = AddReasonCode {
            involuntary,
            notice_required,
            ..add(domain, "합성")
        };
        assert_eq!(
            coded(add_reason_code(&mut store, never, actor(), cmd, audit()).await),
            "reason_class_invalid"
        );
        assert_eq!(store.writes, 0);
    }
}

#[tokio::test]
async fn an_added_exit_reason_keeps_its_class() {
    let mut store = Fake::default();
    let cmd = AddReasonCode {
        involuntary: true,
        notice_required: true,
        ..add("exit_reason", "합성 해고")
    };
    let (view, events) = add_reason_code(&mut store, |_| Ok(()), actor(), cmd, audit())
        .await
        .unwrap();
    assert!(view.involuntary && view.notice_required);
    assert_eq!(view.domain, ReasonDomain::ExitReason);
    assert_eq!(store.writes, 1);
    assert_eq!(events.len(), 1);
}
