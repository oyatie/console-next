//! The BW-07 catalog as the runtime role (`console_rt`, RLS armed): 기타
//! without a note and an inactive code are refused (422), a tenant code joins
//! its domain's catalog before `OTHER`, and codes are tenant-isolated.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::{AuditRequestContext, KernelError, OrgId, TraceContext};
use console_platform_db::{DbError, with_org_conn};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use console_settings_adapter_postgres::{PgSettingsError, PgSettingsStore, validate_reason_in_tx};
use console_settings_application::Actor;
use console_settings_application::reason_codes::{AddReasonCode, UpdateReasonCode};
use console_settings_domain::code_lists::{ReasonDomain, ValidReason};
use sqlx::PgPool;
use uuid::Uuid;

fn audit() -> (TraceContext, AuditRequestContext) {
    (TraceContext::generate(), AuditRequestContext::default())
}

async fn tenant(pool: &PgPool) -> (Actor, PgSettingsStore) {
    let org = Uuid::new_v4();
    let user = seed_org_and_super_admin(pool, org, "reasons").await;
    let actor = Actor {
        org: OrgId::from_uuid(org),
        user,
    };
    (actor, PgSettingsStore::new(runtime_role_pool(pool).await))
}

fn add(label: &str, requires_note: bool) -> AddReasonCode {
    AddReasonCode {
        domain: "period_unlock".to_owned(),
        label_ko: label.to_owned(),
        label_en: None,
        requires_note,
        involuntary: false,
        notice_required: false,
        sort: None,
    }
}

async fn validate(
    store: &PgSettingsStore,
    org: OrgId,
    code: &str,
    note: Option<&str>,
) -> Result<ValidReason, KernelError> {
    let (code, note) = (code.to_owned(), note.map(str::to_owned));
    with_org_conn(store.pool(), org, move |tx| {
        Box::pin(async move {
            Ok::<_, PgSettingsError>(
                validate_reason_in_tx(
                    tx.as_mut(),
                    org,
                    ReasonDomain::PeriodUnlock,
                    &code,
                    note.as_deref(),
                )
                .await,
            )
        })
    })
    .await
    .unwrap()
}

fn code<T: std::fmt::Debug>(result: Result<T, KernelError>) -> &'static str {
    match result {
        Err(KernelError { code: Some(c), .. }) => c,
        other => panic!("expected a coded refusal, got {other:?}"),
    }
}

fn refusal<T: std::fmt::Debug>(result: Result<T, PgSettingsError>) -> &'static str {
    match result {
        Err(PgSettingsError::Domain(e)) => code::<()>(Err(e)),
        other => panic!("expected a coded refusal, got {other:?}"),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn other_needs_a_note_and_unknown_codes_are_invalid(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let ok = validate(&store, actor.org, "AUDIT_FINDING", None)
        .await
        .unwrap();
    assert_eq!(ok.note, None);
    assert_eq!(
        code(validate(&store, actor.org, "OTHER", Some("  ")).await),
        "reason_note_required"
    );
    assert!(
        validate(&store, actor.org, "OTHER", Some("why"))
            .await
            .is_ok()
    );
    assert_eq!(
        code(validate(&store, actor.org, "BOOKS_CLOSE", None).await),
        "reason_code_invalid"
    );
    let unknown = format!("T_{:X}", Uuid::new_v4().simple());
    assert_eq!(
        code(validate(&store, actor.org, &unknown, None).await),
        "reason_code_invalid"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_tenant_code_joins_the_catalog_and_counts_only_while_active(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let added = store
        .add_reason_code(actor, add("시스템 이관", true), audit(), |_| Ok(()))
        .await
        .unwrap();
    assert!(added.code.starts_with("T_") && added.active);

    let catalog = store
        .reason_catalog(actor.org, ReasonDomain::PeriodUnlock)
        .await
        .unwrap();
    let codes: Vec<&str> = catalog.iter().map(|c| c.code.as_str()).collect();
    assert_eq!(
        codes,
        [
            "RETRO_CORRECTION",
            "PAYROLL_ERROR",
            "AUDIT_FINDING",
            added.code.as_str(),
            "OTHER"
        ]
    );
    assert_eq!(catalog[3].label_ko.as_deref(), Some("시스템 이관"));
    assert_eq!(
        code(validate(&store, actor.org, &added.code, None).await),
        "reason_note_required"
    );
    assert!(
        validate(&store, actor.org, &added.code, Some("note"))
            .await
            .is_ok()
    );

    let off = UpdateReasonCode {
        domain: "period_unlock".to_owned(),
        code: added.code.clone(),
        active: Some(false),
        sort: None,
    };
    let updated = store
        .update_reason_code(actor, off, audit(), |_| Ok(()))
        .await
        .unwrap();
    assert!(!updated.active);
    assert_eq!(
        code(validate(&store, actor.org, &added.code, Some("note")).await),
        "reason_code_invalid"
    );

    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action LIKE 'reason_codes.%' AND target_id = $1",
    )
    .bind(format!("period_unlock/{}", added.code))
    // rls-arming: ok test assertion reads as owner
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn admin_refusals_are_coded(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    store
        .add_reason_code(actor, add("중복", false), audit(), |_| Ok(()))
        .await
        .unwrap();
    let again = store
        .add_reason_code(actor, add(" 중복 ", false), audit(), |_| Ok(()))
        .await;
    assert_eq!(refusal(again), "reason_label_taken");
    let system = UpdateReasonCode {
        domain: "period_unlock".to_owned(),
        code: "OTHER".to_owned(),
        active: Some(false),
        sort: None,
    };
    let fixed = store
        .update_reason_code(actor, system, audit(), |_| Ok(()))
        .await;
    assert_eq!(refusal(fixed), "reason_code_system");
    let missing = UpdateReasonCode {
        domain: "period_unlock".to_owned(),
        code: format!("T_{:X}", Uuid::new_v4().simple()),
        active: Some(true),
        sort: None,
    };
    let gone = store
        .update_reason_code(actor, missing, audit(), |_| Ok(()))
        .await;
    assert_eq!(refusal(gone), "reason_code_not_found");
    let denied = store
        .add_reason_code(actor, add("거부", false), audit(), |_| {
            Err(KernelError::forbidden("no"))
        })
        .await;
    assert!(matches!(
        denied,
        Err(PgSettingsError::Domain(KernelError {
            kind: console_kernel_core::ErrorKind::Forbidden,
            ..
        }))
    ));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenant_codes_are_isolated(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let added = store
        .add_reason_code(actor, add("타사 전용", false), audit(), |_| Ok(()))
        .await
        .unwrap();
    let (other, other_store) = tenant(&pool).await;
    assert_eq!(
        code(validate(&other_store, other.org, &added.code, None).await),
        "reason_code_invalid"
    );
    let catalog = other_store
        .reason_catalog(other.org, ReasonDomain::PeriodUnlock)
        .await
        .unwrap();
    assert!(catalog.iter().all(|c| c.system));
    let visible: i64 = with_org_conn(other_store.pool(), other.org, |tx| {
        Box::pin(async move {
            sqlx::query_scalar("SELECT count(*) FROM reason_codes")
                .fetch_one(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, 0, "RLS hides the first tenant's codes");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_void_catalog_serves_system_and_tenant_reasons(pool: PgPool) {
    let (actor, store) = tenant(&pool).await;
    let domain: ReasonDomain = "registration_void".parse().unwrap();
    let mut input = add("잘못 발급한 등록증", false);
    input.domain = domain.as_str().into();
    let added = store
        .add_reason_code(actor, input, audit(), |_| Ok(()))
        .await
        .unwrap();
    let catalog = store.reason_catalog(actor.org, domain).await.unwrap();
    for code in domain.system_codes() {
        assert!(catalog.iter().any(|entry| entry.system
            && entry.code == code.code
            && entry.requires_note == code.requires_note));
    }
    assert!(catalog.iter().any(|entry| !entry.system
        && entry.code == added.code
        && entry.active
        && !entry.requires_note));
    let (other, _) = tenant(&pool).await;
    assert!(
        !store
            .reason_catalog(other.org, domain)
            .await
            .unwrap()
            .iter()
            .any(|entry| entry.code == added.code)
    );
}
