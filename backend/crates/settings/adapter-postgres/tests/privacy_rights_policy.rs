// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::{AuditRequestContext, OrgId, TraceContext};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use console_settings_adapter_postgres::{PgSettingsError, PgSettingsStore};
use console_settings_application::{Actor, reason_codes::AddReasonCode};
use console_settings_domain::SettingValue;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_reason_catalogs_have_only_the_statutory_codes(pool: PgPool) {
    let runtime = runtime_role_pool(&pool).await;
    for (domain, expected) in [
        (
            "privacy_refusal_access",
            vec!["LAW_PROHIBITS", "HARM_TO_OTHERS"],
        ),
        ("privacy_refusal_deletion", vec!["REQUIRED_BY_LAW"]),
        (
            "privacy_refusal_suspension",
            vec!["LAW_REQUIRES", "HARM_TO_OTHERS", "CONTRACT_PERFORMANCE"],
        ),
        ("privacy_postpone_access", vec!["JUSTIFIED_REASON"]),
        (
            "privacy_identity_method",
            vec![
                "SIGNED_IN",
                "ID_DOCUMENT_SEEN",
                "KNOWN_CONTACT",
                "AGENT_MANDATE",
            ],
        ),
    ] {
        let actual: Vec<String> = sqlx::query_scalar(
            "SELECT code FROM system_reason_codes() WHERE domain=$1 ORDER BY sort",
        )
        .bind(domain)
        .fetch_all(&runtime)
        .await
        .unwrap();
        assert_eq!(actual, expected, "{domain}");
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn privacy_catalogs_refuse_tenant_codes_without_writing(pool: PgPool) {
    let org = Uuid::new_v4();
    let user = seed_org_and_super_admin(&pool, org, "privacy-policy").await;
    let actor = Actor {
        org: OrgId::from_uuid(org),
        user,
    };
    let store = PgSettingsStore::new(runtime_role_pool(&pool).await);
    for domain in [
        "privacy_refusal_access",
        "privacy_refusal_deletion",
        "privacy_refusal_suspension",
        "privacy_postpone_access",
        "privacy_identity_method",
    ] {
        let result = store
            .add_reason_code(
                actor,
                AddReasonCode {
                    domain: domain.into(),
                    label_ko: "임의 근거".into(),
                    label_en: None,
                    requires_note: false,
                    involuntary: false,
                    notice_required: false,
                    sort: None,
                },
                (TraceContext::generate(), AuditRequestContext::default()),
                |_| Ok(()),
            )
            .await;
        match result {
            Err(PgSettingsError::Domain(error)) => {
                assert_eq!(error.code, Some("reason_domain_closed"))
            }
            other => panic!("expected closed-domain refusal, got {other:?}"),
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM reason_codes WHERE org_id=$1")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn objection_review_clock_resolves_the_operational_setting(pool: PgPool) {
    let store = PgSettingsStore::new(runtime_role_pool(&pool).await);
    let settings = store.list_effective(OrgId::new(), None).await.unwrap();
    let key = settings
        .iter()
        .find(|row| row.key.as_str() == "privacy.rights.objection_review_days")
        .expect("operational review clock must exist");
    assert_eq!(key.value, Some(SettingValue::Int(10)));
    let definition: (i64, i64, i64) =
        sqlx::query_as("SELECT min_value, max_value, default_ordinal FROM setting_definition($1)")
            .bind(key.key.as_str())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(definition, (1, 30, 10));
}
