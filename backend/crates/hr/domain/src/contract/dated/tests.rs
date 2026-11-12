// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use crate::contract::in_force;
use crate::profile::enums::PayUnit;
use time::macros::date;
use uuid::Uuid;

fn row(id: u128, previous: Option<u128>, on: Option<Date>) -> ContractRow {
    ContractRow {
        id: Uuid::from_u128(id),
        supersedes_id: previous.map(Uuid::from_u128),
        terms: ContractTerms {
            kind: super::super::ContractKind::OpenEnded,
            start_date: date!(2026 - 01 - 01),
            end_date: None,
            wage_won: 3_000_000,
            pay_unit: PayUnit::Monthly,
            weekly_minutes: Some(2400),
            daily_minutes: Some(480),
            scheduled_days_per_week: Some(5),
            weekly_paid_minutes: Some(480),
            terms_effective_from: on,
        },
    }
}

#[test]
fn correction_voids_old_terms_on_every_date_even_when_start_moves() {
    let mut first = row(1, None, None);
    first.terms.weekly_minutes = None;
    let mut corrected = row(2, Some(1), None);
    corrected.terms.start_date = date!(2026 - 03 - 01);
    corrected.terms.wage_won = 3_100_000;
    let rows = [first, corrected];
    assert!(terms_on(&rows, date!(2026 - 02 - 01)).unwrap().is_none());
    assert!(in_force(&rows, date!(2026 - 02 - 01)).is_none());
    assert_eq!(
        terms_on(&rows, date!(2026 - 03 - 01))
            .unwrap()
            .unwrap()
            .terms
            .wage_won,
        3_100_000
    );
}

#[test]
fn explicit_changes_retain_predecessors_and_corrections_keep_the_date() {
    let mut first = row(1, None, None);
    first.terms.end_date = Some(date!(2026 - 12 - 31));
    let mut raise = row(2, Some(1), Some(date!(2026 - 03 - 01)));
    raise.terms.end_date = first.terms.end_date;
    let mut fixed = row(3, Some(2), Some(date!(2026 - 03 - 01)));
    fixed.terms.end_date = first.terms.end_date;
    fixed.terms.wage_won = 9_007_199_254_740_993;
    let mut next = row(4, Some(3), Some(date!(2026 - 07 - 01)));
    next.terms.end_date = first.terms.end_date;
    let mut rows = [first, raise, fixed, next];
    for row in &mut rows {
        row.terms.kind = super::super::ContractKind::FixedTerm;
    }
    for (day, id) in [
        (date!(2026 - 01 - 01), 1),
        (date!(2026 - 02 - 28), 1),
        (date!(2026 - 03 - 01), 3),
        (date!(2026 - 06 - 30), 3),
        (date!(2026 - 07 - 01), 4),
        (date!(2026 - 12 - 31), 4),
    ] {
        assert_eq!(
            terms_on(&rows, day).unwrap().unwrap().id,
            Uuid::from_u128(id)
        );
        assert_eq!(in_force(&rows, day), terms_on(&rows, day).unwrap());
    }
    assert!(terms_on(&rows, date!(2025 - 12 - 31)).unwrap().is_none());
    assert!(terms_on(&rows, date!(2027 - 01 - 01)).unwrap().is_none());
    for &basis in PayUnit::ALL {
        let mut single = row(1, None, None);
        single.terms.pay_unit = basis;
        single.terms.wage_won = 9_007_199_254_740_993;
        assert_eq!(
            terms_on(&[single], date!(2026 - 01 - 01))
                .unwrap()
                .unwrap()
                .terms
                .wage_won,
            9_007_199_254_740_993
        );
    }
}

#[test]
fn lost_or_backdated_effective_dates_are_refused() {
    for on in [None, Some(date!(2026 - 02 - 01))] {
        let rows = [
            row(1, None, Some(date!(2026 - 03 - 01))),
            row(2, Some(1), on),
        ];
        assert_eq!(
            terms_on(&rows, date!(2026 - 01 - 01)).unwrap_err().code,
            Some("contract_terms_date_lost")
        );
        assert!(in_force(&rows, date!(2026 - 04 - 01)).is_none());
    }
}

#[test]
fn ambiguous_terms_are_refused_instead_of_ranked() {
    let rows = [row(1, None, None), row(2, None, None)];
    assert_eq!(
        terms_on(&rows, date!(2026 - 01 - 01)).unwrap_err().code,
        Some("contract_terms_ambiguous")
    );
    assert!(in_force(&rows, date!(2026 - 01 - 01)).is_none());
}

#[test]
fn corrections_retain_facts_and_refuse_a_period_outside_the_effective_date() {
    let original = row(1, None, Some(date!(2026 - 03 - 01))).terms;
    let mut incoming = row(2, None, None).terms;
    incoming.daily_minutes = None;
    incoming.scheduled_days_per_week = None;
    incoming.weekly_paid_minutes = None;
    let corrected = correction_terms(&original, incoming).unwrap();
    assert_eq!(
        corrected.terms_effective_from,
        original.terms_effective_from
    );
    assert_eq!(corrected.daily_minutes, original.daily_minutes);
    assert_eq!(
        corrected.scheduled_days_per_week,
        original.scheduled_days_per_week
    );
    assert_eq!(corrected.weekly_paid_minutes, original.weekly_paid_minutes);
    let mut outside = corrected;
    outside.start_date = date!(2026 - 04 - 01);
    assert_eq!(
        correction_terms(&original, outside).unwrap_err().code,
        Some("contract_terms_effective_date_invalid")
    );
}

#[test]
fn hours_are_exact_without_defaults_and_allow_explicit_zero_paid_time() {
    let terms = row(1, None, None).terms;
    let ratio = monthly_standard_hours(&terms).unwrap();
    assert_eq!(
        ratio,
        MonthlyStandardHours {
            numerator: 1_051_200,
            denominator: 5040
        }
    );
    // 208.571428… hours; the whole-hour payroll convention is 209, applied by the consumer.
    assert_eq!(ratio.numerator * 100 / ratio.denominator, 20_857);
    assert_eq!(
        (ratio.numerator + ratio.denominator / 2) / ratio.denominator,
        209
    );
    for missing in 0..4 {
        let mut absent = terms.clone();
        match missing {
            0 => absent.weekly_minutes = None,
            1 => absent.daily_minutes = None,
            2 => absent.scheduled_days_per_week = None,
            _ => absent.weekly_paid_minutes = None,
        }
        assert!(monthly_standard_hours(&absent).is_none());
    }
    let mut short = terms;
    short.weekly_minutes = Some(840);
    short.daily_minutes = Some(280);
    short.scheduled_days_per_week = Some(3);
    short.weekly_paid_minutes = Some(0);
    assert_eq!(monthly_standard_hours(&short).unwrap().numerator, 840 * 365);
}

#[test]
fn invalid_schedule_and_effective_date_have_stable_reason_codes() {
    for (daily, days, paid) in [
        (0, 5, 480),
        (1441, 5, 480),
        (480, 0, 480),
        (480, 8, 480),
        (480, 5, -1),
        (480, 5, 10081),
    ] {
        let mut invalid = row(1, None, None).terms;
        invalid.daily_minutes = Some(daily);
        invalid.scheduled_days_per_week = Some(days);
        invalid.weekly_paid_minutes = Some(paid);
        assert_eq!(
            validate_terms(&invalid).unwrap_err().code,
            Some("contract_schedule_invalid")
        );
    }
    let mut invalid = row(1, None, Some(date!(2025 - 12 - 31))).terms;
    assert_eq!(
        validate_terms(&invalid).unwrap_err().code,
        Some("contract_terms_effective_date_invalid")
    );
    invalid.terms_effective_from = Some(date!(2027 - 01 - 01));
    invalid.end_date = Some(date!(2026 - 12 - 31));
    invalid.kind = super::super::ContractKind::FixedTerm;
    assert_eq!(
        validate_terms(&invalid).unwrap_err().code,
        Some("contract_terms_effective_date_invalid")
    );
}
