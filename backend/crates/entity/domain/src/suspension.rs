//! 휴업's expected end (catalog company-07): the 휴업 신고 names a 휴업 기간,
//! so a SUSPENDED revision may carry the date it is expected to end. It is a
//! plan, never a clock: 재개 is still a revision back to CONTINUING.

use crate::codes::OperatingStatus;
use crate::refusal::{Issues, NOT_APPLICABLE};

/// `status_until` is never before the 휴업 starts.
pub const UNTIL_BEFORE_SINCE: &str = "status_until_before_since";

/// The expected end of a 휴업: only with SUSPENDED, on or after `since`
/// (any date, a plan may run past today).
pub fn status_until(
    is: &mut Issues,
    raw: Option<&str>,
    status: Option<OperatingStatus>,
    since: Option<time::Date>,
) -> Option<time::Date> {
    let until = is.date("status_until", raw, false, None)?;
    if status != Some(OperatingStatus::Suspended) {
        is.push("status_until", NOT_APPLICABLE);
        return None;
    }
    if since.is_some_and(|s| until < s) {
        is.push("status_until", UNTIL_BEFORE_SINCE);
        return None;
    }
    Some(until)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn run(raw: &str, status: OperatingStatus) -> Result<Option<time::Date>, Vec<&'static str>> {
        let mut is = Issues::default();
        let out = status_until(
            &mut is,
            Some(raw),
            Some(status),
            Some(date!(2026 - 10 - 01)),
        );
        is.finish(|| out)
            .map_err(|r| r.fields.iter().map(|f| f.code).collect())
    }

    #[test]
    fn only_a_suspension_has_an_expected_end_and_it_never_precedes_the_start() {
        assert_eq!(
            run("2026-12-31", OperatingStatus::Suspended),
            Ok(Some(date!(2026 - 12 - 31)))
        );
        assert_eq!(
            run("2026-10-01", OperatingStatus::Suspended),
            Ok(Some(date!(2026 - 10 - 01)))
        );
        assert_eq!(
            run("2026-09-30", OperatingStatus::Suspended),
            Err(vec![UNTIL_BEFORE_SINCE])
        );
        assert_eq!(
            run("2026-12-31", OperatingStatus::Continuing),
            Err(vec![NOT_APPLICABLE])
        );
        assert_eq!(
            run("2026-12-31", OperatingStatus::Closed),
            Err(vec![NOT_APPLICABLE])
        );
        assert_eq!(
            run("31.12.2026", OperatingStatus::Suspended),
            Err(vec!["date_invalid"])
        );
    }
}
