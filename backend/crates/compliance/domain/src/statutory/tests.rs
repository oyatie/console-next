// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use time::macros::date;

fn citation() -> Citation {
    Citation {
        instrument_ko: "근로기준법".into(),
        article_ko: "제36조".into(),
        source_url: "https://www.law.go.kr/법령/근로기준법".into(),
    }
}

fn rule(code: &str, from: Date, to: Option<Date>, num: i64, den: i64) -> StatutoryRule {
    StatutoryRule {
        code: code.into(),
        effective_from: from,
        effective_to_exclusive: to,
        unit: StatutoryUnit::Days,
        value_num: num,
        value_den: den,
        citation: citation(),
        disposition: ReleaseDisposition::Hold,
    }
}

fn loss(insurer: Insurer, code: &str, from: Date, to: Option<Date>) -> InsuranceLossCode {
    InsuranceLossCode {
        insurer,
        code: code.into(),
        label_ko: "정년".into(),
        group: LossReasonGroup::TermEnd,
        requires_detail: false,
        effective_from: from,
        effective_to_exclusive: to,
        citation: citation(),
        disposition: ReleaseDisposition::Hold,
    }
}

fn register(rules: Vec<StatutoryRule>) -> Result<StatutoryRegister, KernelError> {
    StatutoryRegister::new(rules, Vec::new())
}

#[test]
fn rule_lookup_respects_the_half_open_period() {
    let reg = register(vec![
        rule(
            codes::FINAL_PAY_DUE_DAYS,
            date!(2026 - 08 - 20),
            Some(date!(2027 - 01 - 01)),
            14,
            1,
        ),
        rule(codes::FINAL_PAY_DUE_DAYS, date!(2027 - 01 - 01), None, 7, 1),
    ])
    .unwrap();
    let on = |d| reg.rule(codes::FINAL_PAY_DUE_DAYS, d).map(|r| r.value_num);
    assert!(
        on(date!(2026 - 08 - 19)).is_err(),
        "before the first row fails closed"
    );
    assert_eq!(on(date!(2026 - 08 - 20)).unwrap(), 14);
    assert_eq!(on(date!(2026 - 12 - 31)).unwrap(), 14);
    assert_eq!(on(date!(2027 - 01 - 01)).unwrap(), 7, "end is exclusive");
    assert!(
        reg.rule(codes::DISMISSAL_NOTICE_DAYS, date!(2026 - 09 - 30))
            .is_err()
    );
}

#[test]
fn register_rejects_overlap_unknown_codes_and_bad_values() {
    let overlap = register(vec![
        rule(
            codes::FINAL_PAY_DUE_DAYS,
            date!(2026 - 01 - 01),
            None,
            14,
            1,
        ),
        rule(
            codes::FINAL_PAY_DUE_DAYS,
            date!(2026 - 06 - 01),
            None,
            14,
            1,
        ),
    ]);
    assert!(overlap.is_err());
    let bounded_overlap = register(vec![
        rule(
            codes::FINAL_PAY_DUE_DAYS,
            date!(2026 - 01 - 01),
            Some(date!(2026 - 07 - 01)),
            14,
            1,
        ),
        rule(
            codes::FINAL_PAY_DUE_DAYS,
            date!(2026 - 06 - 01),
            None,
            14,
            1,
        ),
    ]);
    assert!(bounded_overlap.is_err());
    assert!(register(vec![rule("MADE_UP", date!(2026 - 01 - 01), None, 1, 1)]).is_err());
    assert!(
        register(vec![rule(
            codes::FINAL_PAY_DUE_DAYS,
            date!(2026 - 01 - 01),
            None,
            14,
            0
        )])
        .is_err()
    );
    assert!(
        register(vec![rule(
            codes::FINAL_PAY_DUE_DAYS,
            date!(2026 - 01 - 01),
            None,
            -1,
            1
        )])
        .is_err()
    );
    let inverted = rule(
        codes::FINAL_PAY_DUE_DAYS,
        date!(2026 - 06 - 01),
        Some(date!(2026 - 06 - 01)),
        14,
        1,
    );
    assert!(register(vec![inverted]).is_err());
    let distinct_codes = register(vec![
        rule(
            codes::FINAL_PAY_DUE_DAYS,
            date!(2026 - 01 - 01),
            None,
            14,
            1,
        ),
        rule(
            codes::SEVERANCE_PAY_DUE_DAYS,
            date!(2026 - 01 - 01),
            None,
            14,
            1,
        ),
    ]);
    assert!(distinct_codes.is_ok());
}

#[test]
fn values_are_read_in_the_unit_the_caller_expects() {
    let days = rule(
        codes::FINAL_PAY_DUE_DAYS,
        date!(2026 - 01 - 01),
        None,
        14,
        1,
    );
    assert_eq!(days.whole(StatutoryUnit::Days).unwrap(), 14);
    assert!(days.whole(StatutoryUnit::Months).is_err());

    let mut rate = rule(
        codes::LATE_WAGE_INTEREST_ANNUAL_RATE,
        date!(2026 - 01 - 01),
        None,
        20,
        100,
    );
    rate.unit = StatutoryUnit::AnnualRate;
    assert_eq!(rate.ratio(StatutoryUnit::AnnualRate).unwrap(), (20, 100));
    assert!(
        rate.whole(StatutoryUnit::AnnualRate).is_err(),
        "fractional is never truncated"
    );
}

#[test]
fn loss_codes_are_per_insurer_and_dated() {
    let reg = StatutoryRegister::new(
        Vec::new(),
        vec![
            loss(Insurer::Ei, "31", date!(2026 - 09 - 18), None),
            loss(
                Insurer::Ei,
                "32",
                date!(2026 - 09 - 18),
                Some(date!(2027 - 01 - 01)),
            ),
            loss(Insurer::Nps, "31", date!(2026 - 09 - 18), None),
        ],
    )
    .unwrap();
    let day = date!(2026 - 09 - 30);
    assert_eq!(reg.loss_code(Insurer::Ei, "31", day).unwrap().code, "31");
    assert!(reg.loss_code(Insurer::Nhis, "31", day).is_err());
    assert!(
        reg.loss_code(Insurer::Ei, "31", date!(2026 - 09 - 17))
            .is_err()
    );
    assert_eq!(reg.loss_codes_on(Insurer::Ei, day).count(), 2);
    assert_eq!(
        reg.loss_codes_on(Insurer::Ei, date!(2027 - 01 - 01))
            .count(),
        1
    );

    let dup = StatutoryRegister::new(
        Vec::new(),
        vec![
            loss(Insurer::Ei, "31", date!(2026 - 09 - 18), None),
            loss(Insurer::Ei, "31", date!(2026 - 10 - 01), None),
        ],
    );
    assert!(dup.is_err());
}

#[test]
fn disposition_requires_a_receipt_exactly_when_released() {
    assert!(ReleaseDisposition::from_db("HOLD", None).unwrap().is_hold());
    let released = ReleaseDisposition::from_db("RELEASED", Some("CTRL-KR-WORKFORCE-001#r1".into()));
    assert!(!released.unwrap().is_hold());
    assert!(ReleaseDisposition::from_db("HOLD", Some("r".into())).is_err());
    assert!(ReleaseDisposition::from_db("RELEASED", None).is_err());
    assert!(ReleaseDisposition::from_db("RELEASED", Some("  ".into())).is_err());
    assert!(ReleaseDisposition::from_db("hold", None).is_err());
}

#[test]
fn db_strings_round_trip_through_the_enums() {
    assert_eq!(
        StatutoryUnit::from_db_str("DAY_OF_NEXT_MONTH").unwrap(),
        StatutoryUnit::DayOfNextMonth
    );
    assert!(StatutoryUnit::from_db_str("WEEKS").is_err());
    assert_eq!(Insurer::from_db_str("NHIS").unwrap(), Insurer::Nhis);
    assert!(Insurer::from_db_str("IACI").is_err());
    assert_eq!(
        LossReasonGroup::from_db_str("INVOLUNTARY_FAULT").unwrap(),
        LossReasonGroup::InvoluntaryFault
    );
    assert!(LossReasonGroup::from_db_str("FIRED").is_err());
}

#[test]
fn rule_codes_are_unique() {
    let mut all = codes::ALL.to_vec();
    all.sort_unstable();
    all.dedup();
    assert_eq!(all.len(), codes::ALL.len());
}

#[test]
fn ins_deadline_keys_answer_from_the_bw30_rows_and_nothing_else() {
    for (alias, code) in codes::INS_DEADLINE_ALIASES {
        assert!(alias.starts_with("ins.deadline.lose."), "{alias}");
        assert!(codes::ALL.contains(&code), "{alias} -> {code}");
        assert_eq!(codes::resolve(alias), code);
    }
    assert_eq!(
        codes::resolve(codes::FINAL_PAY_DUE_DAYS),
        codes::FINAL_PAY_DUE_DAYS
    );
    // A key of the family with no row yet stays unknown: the lookup fails closed.
    assert_eq!(
        codes::resolve("ins.deadline.acquire.nps"),
        "ins.deadline.acquire.nps"
    );
    assert!(codes::ALL.contains(&"ins.deadline.acquire.nps"));
}

#[test]
fn register_codes_and_migration_checks_stay_in_sync() {
    let sql = include_str!("../../../../platform/db/migrations/20261021084358333_exit_guards.sql");
    let latest =
        include_str!("../../../../platform/db/migrations/20261025125900000_lmg_legal_notice.sql");
    let check = latest
        .split("statutory_rules_code_check CHECK (code IN (")
        .nth(1)
        .unwrap()
        .split(")) NOT VALID")
        .next()
        .unwrap();
    let mut listed = check
        .split(',')
        .map(|c| c.trim().trim_matches('\''))
        .collect::<std::collections::BTreeSet<_>>();
    let draft_sql = include_str!(
        "../../../../platform/db/migrations/20261025020100000_lifecycle_trail_product_paths.sql"
    );
    let drafts = draft_sql
        .split("code TEXT NOT NULL CHECK (code IN (")
        .nth(1)
        .unwrap()
        .split("))")
        .next()
        .unwrap()
        .split(',')
        .map(|c| c.trim().trim_matches('\''))
        .collect::<std::collections::BTreeSet<_>>();
    assert!(listed.is_disjoint(&drafts));
    listed.extend(drafts);
    assert_eq!(listed, codes::ALL.into_iter().collect());
    for code in [
        codes::DISMISSAL_PROTECTION_TAIL_DAYS,
        codes::CHILDCARE_LEAVE_DISMISSAL_TAIL_DAYS,
    ] {
        assert!(sql.contains(code));
    }
    assert!(sql.contains("노무사 검토 전"));
}
