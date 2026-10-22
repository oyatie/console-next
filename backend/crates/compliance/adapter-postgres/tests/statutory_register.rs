#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! BW-30: the migrated statutory register loads, validates and answers lookups
//! as the runtime role, and never claims a release the jurisdiction register
//! has not granted.

use console_compliance_adapter_postgres::PgComplianceStore;
use console_compliance_domain::statutory::{
    Insurer, JURISDICTION_CONTROL_ID, StatutoryRegister, StatutoryUnit, codes,
};
use console_platform_test_support::runtime_role_pool;
use sqlx::PgPool;
use time::macros::date;

async fn register(pool: &PgPool) -> StatutoryRegister {
    let rt = runtime_role_pool(pool).await;
    PgComplianceStore::new(rt)
        .statutory_register()
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn every_rule_code_ships_hold_and_future_obligations_wait_for_enforcement(pool: PgPool) {
    let register = register(&pool).await;
    for code in codes::ALL {
        let future = matches!(
            code,
            "ins.filing.monthly_remuneration.ei" | "ins.filing.monthly_remuneration.iaci"
        );
        if future {
            assert!(register.rule(code, date!(2026 - 12 - 31)).is_err());
        }
        let rule = register
            .rule(
                code,
                if future {
                    date!(2027 - 01 - 01)
                } else {
                    date!(2026 - 10 - 02)
                },
            )
            .unwrap();
        assert!(rule.disposition.is_hold(), "{code} must ship HOLD");
        assert!(
            rule.citation
                .source_url
                .starts_with("https://www.law.go.kr/")
        );
    }
    let interest = register
        .rule(codes::LATE_WAGE_INTEREST_ANNUAL_RATE, date!(2026 - 10 - 02))
        .unwrap();
    assert_eq!(
        interest.ratio(StatutoryUnit::AnnualRate).unwrap(),
        (20, 100)
    );
    let min_service = register
        .rule(
            codes::EMPLOYMENT_CERTIFICATE_MIN_SERVICE_DAYS,
            date!(2026 - 10 - 02),
        )
        .unwrap();
    assert_eq!(min_service.whole(StatutoryUnit::Days).unwrap(), 30);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn labour_standards_rows_hand_over_to_the_new_slice_without_a_gap(pool: PgPool) {
    let register = register(&pool).await;
    for code in [
        codes::FINAL_PAY_DUE_DAYS,
        codes::DISMISSAL_NOTICE_DAYS,
        codes::AVERAGE_WAGE_WINDOW_MONTHS,
        codes::EMPLOYMENT_RECORD_RETENTION_YEARS,
    ] {
        let before = register.rule(code, date!(2026 - 10 - 01)).unwrap();
        let after = register.rule(code, date!(2026 - 10 - 02)).unwrap();
        assert_eq!(before.effective_to_exclusive, Some(date!(2026 - 10 - 02)));
        assert_eq!(after.effective_from, date!(2026 - 10 - 02));
        assert_eq!(after.effective_to_exclusive, None);
        assert_eq!(
            (before.value_num, before.value_den),
            (after.value_num, after.value_den)
        );
    }
    // Before the first slice that was read, a lookup fails closed.
    assert!(
        register
            .rule(codes::FINAL_PAY_DUE_DAYS, date!(2026 - 08 - 19))
            .is_err()
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn dismissal_protection_slices_keep_the_sourced_law_and_tail(pool: PgPool) {
    let register = register(&pool).await;
    for (code, tail, article, on, law, until) in [
        (
            codes::DISMISSAL_PROTECTION_TAIL_DAYS,
            30,
            "제23조제2항",
            date!(2026 - 08 - 20),
            "법률 제21373호",
            Some(date!(2026 - 10 - 02)),
        ),
        (
            codes::DISMISSAL_PROTECTION_TAIL_DAYS,
            30,
            "제23조제2항",
            date!(2026 - 10 - 02),
            "법률 제21857호",
            Some(date!(2026 - 10 - 08)),
        ),
        (
            codes::DISMISSAL_PROTECTION_TAIL_DAYS,
            30,
            "제23조제2항",
            date!(2026 - 10 - 08),
            "법률 제21533호",
            None,
        ),
        (
            codes::CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS,
            0,
            "제19조제3항",
            date!(2026 - 08 - 20),
            "법률 제21373호",
            Some(date!(2026 - 09 - 18)),
        ),
        (
            codes::CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS,
            0,
            "제19조제3항",
            date!(2026 - 09 - 18),
            "법률 제21476호",
            None,
        ),
    ] {
        let rule = register.rule(code, on).unwrap();
        assert_eq!(rule.whole(StatutoryUnit::Days).unwrap(), tail);
        let promulgation: String = sqlx::query_scalar(
            "SELECT promulgation_ko FROM statutory_rules WHERE code=$1 AND effective_from=$2",
        )
        .bind(code)
        .bind(rule.effective_from)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(promulgation, law);
        assert_eq!(rule.effective_to_exclusive, until);
        assert!(rule.citation.article_ko.starts_with(article));
        assert!(rule.disposition.is_hold());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn loss_codes_exist_only_where_a_source_was_read(pool: PgPool) {
    let register = register(&pool).await;
    let on = date!(2026 - 10 - 02);
    let ei: Vec<_> = register.loss_codes_on(Insurer::Ei, on).collect();
    assert!(!ei.is_empty());
    assert!(ei.iter().all(|c| c.disposition.is_hold()));
    assert!(
        register
            .loss_code(Insurer::Ei, "26", on)
            .unwrap()
            .requires_detail
    );
    // No NPS or NHIS table has been sourced: the picker is empty and a code fails closed.
    for insurer in [Insurer::Nps, Insurer::Nhis] {
        assert_eq!(register.loss_codes_on(insurer, on).count(), 0);
        assert!(register.loss_code(insurer, "11", on).is_err());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn runtime_role_reads_but_never_writes_the_register(pool: PgPool) {
    for table in ["statutory_rules", "insurance_loss_codes"] {
        for (privilege, expected) in [
            ("SELECT", true),
            ("INSERT", false),
            ("UPDATE", false),
            ("DELETE", false),
            ("TRUNCATE", false),
        ] {
            let granted: bool =
                sqlx::query_scalar("SELECT has_table_privilege('console_rt', $1, $2)")
                    .bind(table)
                    .bind(privilege)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(granted, expected, "console_rt {privilege} on {table}");
        }
    }
}

/// A row may be RELEASED only once its jurisdiction control is no longer HOLD.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn no_row_is_released_while_the_jurisdiction_control_holds(pool: PgPool) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../docs/program/console-jurisdiction-register.json"
    );
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let control = json["controls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == JURISDICTION_CONTROL_ID)
        .unwrap_or_else(|| panic!("{JURISDICTION_CONTROL_ID} missing from the register"));
    if control["release_disposition"] != "HOLD" {
        return;
    }
    let released: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM statutory_rules WHERE release_disposition <> 'HOLD') \
              + (SELECT count(*) FROM insurance_loss_codes WHERE release_disposition <> 'HOLD')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(released, 0);
}
