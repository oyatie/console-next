//! BW-12: the 육아휴직 periods that do not count toward fixed-term service
//! (남녀고용평등법 §19⑤), folded from an employee's APPLIED lifecycle events.

use time::Date;

use super::fixed_term::DatePeriod;

/// One APPLIED lifecycle event, in effective-date order.
#[derive(Debug, Clone, Copy)]
pub struct AppliedEvent<'a> {
    pub event_type: &'a str,
    pub leave_type: Option<&'a str>,
    pub effective_date: Date,
    pub expected_return_date: Option<Date>,
}

/// Each CHILDCARE leave runs from its date to the day before the next
/// RETURN_FROM_LEAVE or TERMINATE; a leave still open ends the day before its
/// expected return, or on `as_of` when none was given.
#[must_use]
pub fn childcare_periods(events: &[AppliedEvent<'_>], as_of: Date) -> Vec<DatePeriod> {
    let mut periods = Vec::new();
    let mut open: Option<&AppliedEvent<'_>> = None;
    for event in events {
        match event.event_type {
            "LEAVE_OF_ABSENCE" if event.leave_type == Some("CHILDCARE") => open = Some(event),
            "RETURN_FROM_LEAVE" | "TERMINATE" => {
                if let Some(start) = open.take() {
                    periods.push(span(
                        start.effective_date,
                        event.effective_date.previous_day(),
                    ));
                }
            }
            _ => {}
        }
    }
    if let Some(start) = open {
        let end = start
            .expected_return_date
            .and_then(Date::previous_day)
            .unwrap_or(as_of);
        periods.push(span(start.effective_date, Some(end)));
    }
    periods.retain(|p| p.start <= p.end);
    periods
}

fn span(start: Date, end: Option<Date>) -> DatePeriod {
    DatePeriod {
        start,
        end: end.unwrap_or(start),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn ev(
        event_type: &'static str,
        leave_type: Option<&'static str>,
        on: Date,
    ) -> AppliedEvent<'static> {
        AppliedEvent {
            event_type,
            leave_type,
            effective_date: on,
            expected_return_date: None,
        }
    }

    #[test]
    fn a_childcare_leave_ends_the_day_before_the_return() {
        let events = [
            ev("LEAVE_OF_ABSENCE", Some("CHILDCARE"), date!(2026 - 01 - 01)),
            ev("RETURN_FROM_LEAVE", None, date!(2026 - 05 - 01)),
            ev("LEAVE_OF_ABSENCE", Some("ILLNESS"), date!(2026 - 06 - 01)),
            ev("RETURN_FROM_LEAVE", None, date!(2026 - 07 - 01)),
        ];
        assert_eq!(
            childcare_periods(&events, date!(2026 - 10 - 01)),
            [DatePeriod {
                start: date!(2026 - 01 - 01),
                end: date!(2026 - 04 - 30)
            }]
        );
    }

    #[test]
    fn an_open_leave_runs_to_its_expected_return_or_today() {
        let mut leave = ev("LEAVE_OF_ABSENCE", Some("CHILDCARE"), date!(2026 - 09 - 01));
        assert_eq!(
            childcare_periods(&[leave], date!(2026 - 10 - 01))[0].end,
            date!(2026 - 10 - 01)
        );
        leave.expected_return_date = Some(date!(2027 - 03 - 01));
        assert_eq!(
            childcare_periods(&[leave], date!(2026 - 10 - 01))[0].end,
            date!(2027 - 02 - 28)
        );
    }
}
