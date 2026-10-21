use super::{Exclusion, FilingFacts, Reason};

/// An exception is false only after every eligible fact is known.
fn exception(
    values: &[(&'static str, Option<bool>)],
    missing: &mut Vec<&'static str>,
) -> Option<bool> {
    if values.iter().any(|(_, v)| *v == Some(true)) {
        return Some(true);
    }
    let unknown = values.iter().any(|(_, v)| v.is_none());
    if unknown {
        missing.extend(
            values
                .iter()
                .filter_map(|(name, v)| v.is_none().then_some(*name)),
        );
        None
    } else {
        Some(false)
    }
}

pub(super) fn evaluate(
    rule: &Exclusion,
    f: &FilingFacts,
    missing: &mut Vec<&'static str>,
) -> (Reason, Option<bool>) {
    let mut unknown = Vec::new();
    let result = evaluate_inner(rule, f, &mut unknown);
    if result.1.is_none() {
        missing.extend(unknown);
    }
    result
}

fn evaluate_inner(
    rule: &Exclusion,
    f: &FilingFacts,
    missing: &mut Vec<&'static str>,
) -> (Reason, Option<bool>) {
    match rule {
        Exclusion::ShortHours {
            monthly,
            weekly,
            continuous_months_exception,
            pension_exceptions,
            daily_exception,
        } => {
            // Pension daily work has its own day/hour/income test.
            if *pension_exceptions && f.daily == Some(true) {
                return (Reason::ShortHours, Some(false));
            }
            let low = match (f.monthly_hours, weekly.map(|_| f.weekly_hours)) {
                (Some(m), Some(Some(w))) => Some(m < *monthly || weekly.is_some_and(|n| w < n)),
                (Some(m), None) => Some(m < *monthly),
                _ => {
                    missing.push("hours");
                    None
                }
            };
            if low == Some(false) {
                return (Reason::ShortHours, Some(false));
            }
            let mut values = Vec::new();
            if let Some(n) = continuous_months_exception {
                values.push(("continuous_months", f.continuous_months.map(|m| m >= *n)));
            }
            if *daily_exception || *pension_exceptions {
                values.push(("daily", f.daily));
            }
            if *pension_exceptions {
                values.extend([
                    ("pension_opt_in", f.pension_opt_in),
                    ("pension_lecturer_covered", f.pension_lecturer_covered),
                    ("multiple_jobs_covered", f.multiple_jobs_covered),
                    ("income_exception_covered", f.income_exception_covered),
                ]);
            }
            let except = exception(&values, missing);
            (
                Reason::ShortHours,
                if except == Some(true) {
                    Some(false)
                } else {
                    low.zip(except).map(|(low, _)| low)
                },
            )
        }
        Exclusion::Daily {
            minimum_months,
            days_exception,
            hours_exception,
            income_exception,
            work_confirmation,
        } => {
            let reason = if *work_confirmation {
                Reason::DailyWorkConfirmation
            } else {
                Reason::DailyUnderMonth
            };
            let verdict = match f.daily {
                Some(false) => Some(false),
                None => {
                    missing.push("daily");
                    None
                }
                Some(true) if *work_confirmation => Some(true),
                Some(true) => match f.continuous_months {
                    None => {
                        missing.push("continuous_months");
                        None
                    }
                    Some(m) if m < *minimum_months => Some(true),
                    Some(_) => {
                        let mut values = Vec::new();
                        if let Some(n) = days_exception {
                            values.push(("work_days", f.work_days.map(|d| d >= *n)));
                        }
                        if let Some(n) = hours_exception {
                            values.push((
                                "worked_monthly_hours",
                                match (f.worked_monthly_hours, f.pension_daily_sector) {
                                    (Some(h), _) if h < *n => Some(false),
                                    (_, Some(super::PensionDailySector::ConstructionNotice)) => {
                                        Some(false)
                                    }
                                    (Some(_), Some(super::PensionDailySector::General)) => {
                                        Some(true)
                                    }
                                    _ => None,
                                },
                            ));
                        }
                        if *income_exception {
                            values.push(("income_exception_covered", f.income_exception_covered));
                        }
                        if values.is_empty() {
                            Some(false)
                        } else {
                            exception(&values, missing).map(|v| !v)
                        }
                    }
                },
            };
            (reason, verdict)
        }
        Exclusion::Income {
            threshold_won,
            continuous_months_exception,
        } => {
            let except = exception(
                &[
                    ("daily", f.daily),
                    (
                        "continuous_months",
                        f.continuous_months
                            .map(|m| m >= *continuous_months_exception),
                    ),
                    ("multiple_jobs_covered", f.multiple_jobs_covered),
                ],
                missing,
            );
            let verdict = if except == Some(true) {
                Some(false)
            } else {
                match (threshold_won, f.monthly_income_won) {
                    (Some(t), Some(i)) if i >= *t => Some(false),
                    (Some(_), Some(_)) => except.map(|_| true),
                    _ => {
                        missing.push("income_threshold_pending");
                        None
                    }
                }
            };
            (Reason::ShortHours, verdict)
        }
        _ => unreachable!("work coverage accepts work exclusions only"),
    }
}
