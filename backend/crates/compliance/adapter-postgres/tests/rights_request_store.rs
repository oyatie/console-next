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
