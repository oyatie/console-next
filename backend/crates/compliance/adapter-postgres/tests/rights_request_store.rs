// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_compliance_adapter_postgres::PgComplianceStore;
use console_compliance_domain::statutory::{StatutoryRegister, StatutoryUnit};
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::macros::date;

const CODES: [&str; 3] = [
    "PIPA_ACCESS_RESPONSE_DAYS",
    "PIPA_CORRECTION_RESPONSE_DAYS",
    "PIPA_SUSPENSION_RESPONSE_DAYS",
];
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rights_clocks_load_through_runtime_register_and_ship_hold(pool: PgPool) {
    let register = PgComplianceStore::new(runtime_role_pool(&pool).await)
        .statutory_register()
        .await
        .unwrap();
    for code in CODES {
        let rule = register.rule(code, date!(2026 - 10 - 27)).unwrap();
        assert_eq!(rule.whole(StatutoryUnit::Days).unwrap(), 10);
        assert_eq!(rule.effective_from, date!(2026 - 09 - 11));
        assert!(rule.disposition.is_hold());
        assert!(register.rule(code, date!(2026 - 09 - 10)).is_err());
        let mut duplicate = rule.clone();
        duplicate.effective_from = date!(2026 - 10 - 01);
        assert!(StatutoryRegister::new(vec![rule.clone(), duplicate], vec![]).is_err());
        let source: (String, String, time::Date) = sqlx::query_as(
            "SELECT promulgation_ko, source_url, retrieved_on FROM statutory_rules WHERE code=$1",
        )
        .bind(code)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(source.0, "대통령령 제36671호");
        assert!(source.1.contains("289537"));
        assert_eq!(source.2, date!(2026 - 10 - 27));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn rights_decisions_consume_the_settings_catalog_and_preserve_hold(pool: PgPool) {
    use console_compliance_domain::rights::{
        AgentKind, Channel, Controller, Decision, IdentityMethod, Kind, Outcome, Receipt,
        RightsRequest,
    };
    use std::collections::BTreeMap;
    let runtime = runtime_role_pool(&pool).await;
    let register = PgComplianceStore::new(runtime.clone())
        .statutory_register()
        .await
        .unwrap();
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT domain, code FROM system_reason_codes() WHERE domain LIKE 'privacy_%' ORDER BY domain, sort")
        .fetch_all(&runtime).await.unwrap();
    let mut catalog: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (domain, code) in rows {
        catalog.entry(domain).or_default().push(code);
    }
    let today = date!(2026 - 10 - 27);
    let receipt = Receipt {
        id: uuid::Uuid::new_v4(),
        controller: Controller::Tenant,
        channel: Channel::InApp,
        agent: AgentKind::Subject,
        mandate_received: false,
        identity_method: IdentityMethod::SignedIn,
        identity_at: time::OffsetDateTime::UNIX_EPOCH,
        received_on: today,
    };
    let new_request =
        || RightsRequest::receive(receipt.clone(), [Kind::Access], &register, today, None).unwrap();
    for invalid in [
        "REQUIRED_BY_LAW",
        "LAW_REQUIRES",
        "CONTRACT_PERFORMANCE",
        "JUSTIFIED_REASON",
        "OTHER",
        "PUBLIC_BODY",
    ] {
        let mut request = new_request();
        assert!(
            request
                .decide(
                    Kind::Access,
                    Decision {
                        outcome: Outcome::Refused,
                        reason: Some(invalid.into()),
                        note: Some("근거 확인".into())
                    },
                    today,
                    today,
                    &catalog
                )
                .is_err()
        );
        assert!(request.kinds()[&Kind::Access].decisions.is_empty());
    }
    let mut request = new_request();
    let due = request.kinds()[&Kind::Access].due.as_ref().unwrap();
    assert_eq!(due.on, Some(date!(2026 - 11 - 06)));
    assert!(due.rule.as_ref().unwrap().disposition.is_hold());
    request
        .decide(
            Kind::Access,
            Decision {
                outcome: Outcome::Refused,
                reason: Some("LAW_PROHIBITS".into()),
                note: Some("근거 확인".into()),
            },
            today,
            today,
            &catalog,
        )
        .unwrap();
    let (review_days,): (i64,) = sqlx::query_as(
        "SELECT default_ordinal FROM setting_definition('privacy.rights.objection_review_days')",
    )
    .fetch_one(&runtime)
    .await
    .unwrap();
    let objection = RightsRequest::receive(
        receipt,
        [Kind::Access],
        &register,
        today,
        Some((&request, u16::try_from(review_days).unwrap())),
    )
    .unwrap();
    assert_eq!(
        objection.kinds()[&Kind::Access].due.as_ref().unwrap().on,
        Some(date!(2026 - 11 - 06))
    );
}
