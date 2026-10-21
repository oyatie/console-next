use super::*;
use time::macros::date;

fn rules() -> AssignRules<'static> {
    AssignRules {
        effective_from: date!(2026 - 11 - 01),
        effective_to: None,
        reason: LayerReason::Standard,
        evidence_ref: None,
        person_scope: false,
        pattern_active: true,
        start_choices: None,
        start_choice: None,
        closed_months: &[],
    }
}

#[test]
fn a_plain_assignment_passes() {
    assert_eq!(check_assign(&rules()), Ok(()));
}

#[test]
fn each_rule_refuses_with_its_code() {
    let cases: [(AssignRules<'static>, ScheduleRefusal); 6] = [
        (
            AssignRules {
                effective_to: Some(date!(2026 - 11 - 01)),
                ..rules()
            },
            ScheduleRefusal::EffectiveRangeInvalid,
        ),
        (
            AssignRules {
                pattern_active: false,
                ..rules()
            },
            ScheduleRefusal::PatternRetired,
        ),
        (
            AssignRules {
                reason: LayerReason::Reduction,
                evidence_ref: Some(" "),
                ..rules()
            },
            ScheduleRefusal::EvidenceRequired,
        ),
        (
            AssignRules {
                reason: LayerReason::Substitute,
                person_scope: true,
                effective_to: Some(date!(2026 - 11 - 03)),
                ..rules()
            },
            ScheduleRefusal::SubstituteNeedsEnd,
        ),
        (
            AssignRules {
                start_choice: Some(600),
                start_choices: Some(&[540, 600]),
                ..rules()
            },
            ScheduleRefusal::StartChoiceInvalid,
        ),
        (
            AssignRules {
                closed_months: &[(2026, 12)],
                ..rules()
            },
            ScheduleRefusal::MonthClosed,
        ),
    ];
    for (r, want) in cases {
        assert_eq!(check_assign(&r), Err(want), "{want:?}");
        assert!(!want.code().is_empty());
    }
}

#[test]
fn a_closed_month_before_the_start_or_after_a_bounded_end_does_not_block() {
    let bounded = AssignRules {
        effective_to: Some(date!(2026 - 12 - 01)),
        closed_months: &[(2026, 10), (2026, 12)],
        ..rules()
    };
    assert_eq!(check_assign(&bounded), Ok(()));
}

#[test]
fn a_one_day_substitute_and_a_valid_staggered_choice_pass() {
    let cover = AssignRules {
        reason: LayerReason::Substitute,
        person_scope: true,
        effective_to: Some(date!(2026 - 11 - 02)),
        ..rules()
    };
    assert_eq!(check_assign(&cover), Ok(()));
    let choice = AssignRules {
        person_scope: true,
        start_choice: Some(600),
        start_choices: Some(&[540, 600]),
        ..rules()
    };
    assert_eq!(check_assign(&choice), Ok(()));
}

#[test]
fn a_layer_cancels_only_before_its_first_day() {
    let today = date!(2026 - 10 - 09);
    assert_eq!(check_cancel(today, date!(2026 - 10 - 10)), Ok(()));
    assert_eq!(
        check_cancel(today, today),
        Err(ScheduleRefusal::LayerInEffect)
    );
    assert_eq!(
        check_cancel(today, date!(2026 - 10 - 01)),
        Err(ScheduleRefusal::LayerInEffect)
    );
}

#[test]
fn every_refusal_has_its_stable_wire_code_and_status_class() {
    use ScheduleRefusal as R;
    let all = [
        (R::ShiftWindowInvalid, "shift_window_invalid", false),
        (R::BreakBelowMinimum, "break_below_minimum", false),
        (R::DailyHoursOver8, "daily_hours_over_8", false),
        (R::WeeklyHoursOver40, "weekly_hours_over_40", false),
        (R::WeeklyHolidayMissing, "weekly_holiday_missing", false),
        (R::StartChoiceInvalid, "start_choice_invalid", false),
        (R::RegimeNotSupportedYet, "regime_not_supported_yet", false),
        (R::PatternRetired, "pattern_retired", true),
        (R::PatternInUse, "pattern_in_use", true),
        (R::MonthClosed, "schedule_month_closed", true),
        (R::LayerInEffect, "schedule_layer_in_effect", true),
        (R::EvidenceRequired, "evidence_required", false),
        (R::SubstituteNeedsEnd, "substitute_needs_end", false),
        (R::EffectiveRangeInvalid, "effective_range_invalid", false),
    ];
    for (r, code, conflict) in all {
        assert_eq!((r.code(), r.is_conflict()), (code, conflict));
    }
}
