//! Labor Standards Act Article 61 (promotion of the use of annual paid leave)
//! — the statutory timing rules.
//!
//! # Why this module exists
//!
//! The previous implementation validated a §61 push with a single check —
//! `round ∈ {1, 2}` — while the notice it produced asserted that the employer's
//! obligation to compensate unused annual leave had been extinguished. §61
//! grants that relief **only** when each promotion step was taken inside its
//! own statutory window, in writing, in
//! order. A push served on any other date produces a document that looks
//! authoritative and is legally void. This module makes the windows real.
//!
//! # Statutory source (verified LIVE, not from model memory)
//!
//! - Labor Standards Act Article 61, quoted below in English translation of the
//!   text at the National Law Information Center
//!   <https://www.law.go.kr/lsLinkProc.do?ancYd=20160302&lsClsCd=L&lsNm=%EA%B7%BC%EB%A1%9C%EA%B8%B0%EC%A4%80%EB%B2%95&lsId=2031481&joNo=006100000&mode=4>
//!   and cross-checked against CaseNote
//!   <https://casenote.kr/%EB%B2%95%EB%A0%B9/%EA%B7%BC%EB%A1%9C%EA%B8%B0%EC%A4%80%EB%B2%95/%EC%A0%9C61%EC%A1%B0>
//!   — accessed 2026-07-25.
//!   Current text: [in force 2020. 3. 31.] [Act No. 17185, 2020. 3. 31.,
//!   partial amendment].
//! - Labor Standards Act Article 60(7) (the expiry period this article counts
//!   back from),
//!   <https://casenote.kr/%EB%B2%95%EB%A0%B9/%EA%B7%BC%EB%A1%9C%EA%B8%B0%EC%A4%80%EB%B2%95/%EC%A0%9C60%EC%A1%B0>
//!   — accessed 2026-07-25.
//! - Refusal to accept labour: Ministry of Employment and Labor quick online
//!   consultation
//!   <https://www.moel.go.kr/minwon/fastcounsel/fastcounselView.do?inetDcssMngId=202310041607201011000>
//!   — accessed 2026-07-25 — citing Supreme Court 2019Da279283 (decided
//!   2020. 2. 27.): "where the worker comes to work on their designated leave
//!   day, the employer should clearly express an 'intent to refuse to accept
//!   the labour'". The refusal is therefore a **factual act** by the
//!   employer, not a computable consequence — see [`crate::PromotionKind`].
//!
//! # The two windows (statute text, in English translation)
//!
//! §61①1 — "within **10 days counted from 6 months before** the end of the
//! period under the main text of Article 60(7), the employer shall tell each
//! worker the number of their unused leave days and urge the worker **in
//! writing** to set the timing of its use and notify the employer".
//!
//! §61①2 — "…if the worker does not … notify **within 10 days** of receiving
//! the urging, … the employer shall, **no later than 2 months before** the
//! period ends, **set the timing of use** of the unused leave and notify the
//! worker of it **in writing**".
//!
//! §61②1 — "**within 10 days counted from 3 months before** the first year of
//! employment ends … Provided, that for leave that arises after the employer's
//! written urging, the urging shall be made **within 5 days counted from 1
//! month before** the first year of employment ends."
//!
//! §61②2 — "…**no later than 1 month before** the first year of employment
//! ends … Provided, that for leave urged under the proviso to subparagraph 1,
//! the notice shall be given in writing **no later than 10 days before** the
//! first year of employment ends."
//!
//! # Day-count convention
//!
//! The statute's "N months before … ends" is read as the calendar date N months
//! before the period end, and the window opens the **following** day, so that
//! the remaining span is exactly N months. For the fiscal-year (1/1–12/31) case
//! this yields the published administrative answer — first-round urging
//! 2026-07-01 ~ 2026-07-10, second-round notice deadline 2026-10-31 — see Shopl
//! (Labor Standards Act §61 operating guide),
//! <https://www.shoplworks.com/blog-insight/annual-leave-promotion-procedure-calculation-jun>
//! — accessed 2026-07-25: "If annual leave expires on December 31 on a
//! fiscal-year basis, the notice must be completed between July 1 and July
//! 10." The same convention is applied to every
//! other lead period in this module; each computed window is written into the
//! push's audit snapshot so the arithmetic is inspectable after the fact.

use console_kernel_core::{Date, KernelError};
use serde::{Deserialize, Serialize};
use time::{Duration, Month};

/// §61①1 — "counted from 6 months before the period ends".
const ANNUAL_FIRST_LEAD_MONTHS: i32 = 6;
/// §61②1 main text — "counted from 3 months before the first year of employment ends".
const FIRST_YEAR_EARLY_FIRST_LEAD_MONTHS: i32 = 3;
/// §61②1 proviso — "counted from 1 month before the first year of employment ends".
const FIRST_YEAR_LATE_FIRST_LEAD_MONTHS: i32 = 1;
/// §61①1 / §61②1 main text — "within 10 days".
const TEN_DAY_SPAN: i64 = 10;
/// §61②1 proviso — "within 5 days".
const FIVE_DAY_SPAN: i64 = 5;
/// §61①2 — "no later than 2 months before the period ends".
const ANNUAL_SECOND_LEAD_MONTHS: i32 = 2;
/// §61②2 main text — "no later than 1 month before the first year of employment ends".
const FIRST_YEAR_EARLY_SECOND_LEAD_MONTHS: i32 = 1;
/// §61②2 proviso — "no later than 10 days before the first year of employment ends".
const FIRST_YEAR_LATE_SECOND_LEAD_DAYS: i64 = 10;
/// §61①2 / §61②2 — "if the worker does not … notify within 10 days of
/// receiving the urging".
/// Round 2 only becomes available once that reply window has closed.
const REPLY_WINDOW_DAYS: i64 = 10;
/// Bound on a round-2 designation so one notice cannot carry an unbounded
/// payload. 25 is the statutory maximum annual entitlement (Article 60(4) proviso).
const MAX_DESIGNATED_DATES: usize = 25;

/// Which §61 track the promoted leave sits on. The tracks have *different*
/// statutory windows, so this is a required input, never a default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromotionTrack {
    /// §61① — annual leave under Article 60(1), (2) and (4) on the ordinary 1-year use period.
    Annual,
    /// §61②1 main text — under 1 year of continuous service, for leave that
    /// accrued **before** the first-round urging (the first nine monthly days).
    FirstYearEarly,
    /// §61②1 proviso — under 1 year of continuous service, for leave that
    /// accrued **after** the first-round urging (the last two monthly days).
    FirstYearLate,
}

impl PromotionTrack {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Annual => "annual",
            Self::FirstYearEarly => "first_year_early",
            Self::FirstYearLate => "first_year_late",
        }
    }

    pub fn parse(value: &str) -> Result<Self, KernelError> {
        match value {
            "annual" => Ok(Self::Annual),
            "first_year_early" => Ok(Self::FirstYearEarly),
            "first_year_late" => Ok(Self::FirstYearLate),
            other => Err(KernelError::validation(format!(
                "unknown §61 promotion track: {other} \
                 (expected annual|first_year_early|first_year_late)"
            ))),
        }
    }

    /// The paragraph this track is governed by, for the notice's legal basis.
    #[must_use]
    pub fn statute_paragraph(self) -> &'static str {
        match self {
            Self::Annual => "근로기준법 제61조제1항",
            Self::FirstYearEarly | Self::FirstYearLate => "근로기준법 제61조제2항",
        }
    }

    const fn first_round_lead_months(self) -> i32 {
        match self {
            Self::Annual => ANNUAL_FIRST_LEAD_MONTHS,
            Self::FirstYearEarly => FIRST_YEAR_EARLY_FIRST_LEAD_MONTHS,
            Self::FirstYearLate => FIRST_YEAR_LATE_FIRST_LEAD_MONTHS,
        }
    }

    const fn first_round_span_days(self) -> i64 {
        match self {
            Self::Annual | Self::FirstYearEarly => TEN_DAY_SPAN,
            Self::FirstYearLate => FIVE_DAY_SPAN,
        }
    }
}

/// An inclusive statutory service window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromotionWindow {
    pub opens_on: Date,
    pub closes_on: Date,
}

impl PromotionWindow {
    #[must_use]
    pub fn contains(&self, date: Date) -> bool {
        date >= self.opens_on && date <= self.closes_on
    }
}

/// The facts a §61 push is judged against. Every field is evidence the employer
/// must already hold; none of it is inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromotionContext {
    pub track: PromotionTrack,
    /// The **last day** of the period under the main text of Article 60(7) — for
    /// §61② tracks, the end date of the first year of employment.
    pub period_end: Date,
    /// The org-local (KST) date the notice is served on.
    pub served_on: Date,
    /// The KST date round 1 was served, when it is already recorded.
    pub first_round_served_on: Option<Date>,
    /// The KST date round 2 was served, when it is already recorded.
    pub second_round_served_on: Option<Date>,
}

/// The first-round urging window: [`period_end` − lead months + 1 day, + span − 1 day].
pub fn first_round_window(
    track: PromotionTrack,
    period_end: Date,
) -> Result<PromotionWindow, KernelError> {
    let anchor = minus_months(period_end, track.first_round_lead_months())
        .ok_or_else(|| out_of_range(period_end))?;
    let opens_on = anchor
        .checked_add(Duration::days(1))
        .ok_or_else(|| out_of_range(period_end))?;
    let closes_on = opens_on
        .checked_add(Duration::days(track.first_round_span_days() - 1))
        .ok_or_else(|| out_of_range(period_end))?;
    Ok(PromotionWindow {
        opens_on,
        closes_on,
    })
}

/// The second-round notice deadline — the last day the employer may designate use dates.
pub fn second_round_deadline(track: PromotionTrack, period_end: Date) -> Result<Date, KernelError> {
    match track {
        PromotionTrack::Annual => minus_months(period_end, ANNUAL_SECOND_LEAD_MONTHS),
        PromotionTrack::FirstYearEarly => {
            minus_months(period_end, FIRST_YEAR_EARLY_SECOND_LEAD_MONTHS)
        }
        PromotionTrack::FirstYearLate => {
            period_end.checked_sub(Duration::days(FIRST_YEAR_LATE_SECOND_LEAD_DAYS))
        }
    }
    .ok_or_else(|| out_of_range(period_end))
}

/// Validate one annual-leave use promotion round against §61. Returns the
/// canonical round.
///
/// Round 1 must land inside its statutory window. Round 2 additionally requires
/// a recorded round 1, the worker's 10-day reply window to have closed, and
/// service on or before the second-round notice deadline.
pub fn validate_promotion(context: &PromotionContext, round: i16) -> Result<i16, KernelError> {
    match round {
        1 => {
            let window = first_round_window(context.track, context.period_end)?;
            if window.contains(context.served_on) {
                Ok(1)
            } else {
                Err(KernelError::validation(format!(
                    "1차 촉구는 {}~{} 사이에만 유효합니다 ({} 제1호). 서비스 일자: {}",
                    window.opens_on,
                    window.closes_on,
                    context.track.statute_paragraph(),
                    context.served_on
                )))
            }
        }
        2 => {
            let first_served = context.first_round_served_on.ok_or_else(|| {
                KernelError::conflict(format!(
                    "2차 통보는 기록된 1차 촉구 이후에만 가능합니다 ({} 제2호)",
                    context.track.statute_paragraph()
                ))
            })?;
            let reply_closes = first_served
                .checked_add(Duration::days(REPLY_WINDOW_DAYS))
                .ok_or_else(|| out_of_range(first_served))?;
            if context.served_on <= reply_closes {
                return Err(KernelError::validation(format!(
                    "근로자의 회신 기간(1차 촉구 후 10일, {reply_closes}까지)이 끝난 뒤에야 \
                     2차 통보를 할 수 있습니다. 서비스 일자: {}",
                    context.served_on
                )));
            }
            let deadline = second_round_deadline(context.track, context.period_end)?;
            if context.served_on > deadline {
                return Err(KernelError::validation(format!(
                    "2차 통보 기한({deadline})이 지났습니다 ({} 제2호). 서비스 일자: {}",
                    context.track.statute_paragraph(),
                    context.served_on
                )));
            }
            Ok(2)
        }
        other => Err(KernelError::validation(format!(
            "연차 촉진 round must be 1 or 2 (근로기준법 제61조), got {other}"
        ))),
    }
}

/// Validate a refusal-to-accept-labour notice. §61 does not time this act — it
/// is the employer's factual refusal of labour on a designated day, required
/// by Supreme Court 2019Da279283 for the §61 relief to hold — so the only
/// checks are that
/// a round-2 designation exists, that the refusal does not precede it, and that
/// it falls inside the leave period it refuses labour within.
///
/// Returns the canonical stored round (`2`, the round it follows).
pub fn validate_refusal(context: &PromotionContext) -> Result<i16, KernelError> {
    let second_served = context.second_round_served_on.ok_or_else(|| {
        KernelError::conflict(
            "노무수령거부 통지는 기록된 2차 통보(사용 시기 지정) 이후에만 가능합니다 \
             (근로기준법 제61조, 대법원 2019다279283)",
        )
    })?;
    if context.served_on < second_served {
        return Err(KernelError::validation(format!(
            "노무수령거부 통지는 2차 통보일({second_served}) 이후여야 합니다. 서비스 일자: {}",
            context.served_on
        )));
    }
    if context.served_on > context.period_end {
        return Err(KernelError::validation(format!(
            "노무수령거부 통지는 연차 사용기간 종료일({}) 이후에는 의미가 없습니다. \
             서비스 일자: {}",
            context.period_end, context.served_on
        )));
    }
    Ok(2)
}

/// Validate the timing of use a round-2 notice designates. §61①2 requires the
/// notice to *designate the dates*; a round-2 notice with no dates is not a §61
/// notice at
/// all, however authoritative it reads.
pub fn validate_designated_dates(
    dates: &[Date],
    served_on: Date,
    period_end: Date,
) -> Result<(), KernelError> {
    if dates.is_empty() {
        return Err(KernelError::validation(
            "2차 통보는 사용 시기를 지정해야 합니다 (근로기준법 제61조제1항제2호)",
        ));
    }
    if dates.len() > MAX_DESIGNATED_DATES {
        return Err(KernelError::validation(format!(
            "지정 가능한 사용 시기는 최대 {MAX_DESIGNATED_DATES}일입니다"
        )));
    }
    let mut seen = dates.to_vec();
    seen.sort_unstable();
    seen.dedup();
    if seen.len() != dates.len() {
        return Err(KernelError::validation(
            "지정된 사용 시기에 중복된 날짜가 있습니다",
        ));
    }
    for date in dates {
        if *date <= served_on {
            return Err(KernelError::validation(format!(
                "지정된 사용 시기 {date}는 통보일({served_on}) 이후여야 합니다"
            )));
        }
        if *date > period_end {
            return Err(KernelError::validation(format!(
                "지정된 사용 시기 {date}는 연차 사용기간 종료일({period_end})을 넘을 수 없습니다"
            )));
        }
    }
    Ok(())
}

/// Calendar-month subtraction with end-of-month clamping (3-31 minus one month
/// is 2-28/2-29, never a non-existent date).
fn minus_months(date: Date, months: i32) -> Option<Date> {
    let index = date.year() * 12 + i32::from(u8::from(date.month())) - 1 - months;
    let year = index.div_euclid(12);
    let month = Month::try_from(u8::try_from(index.rem_euclid(12) + 1).ok()?).ok()?;
    (1..=date.day())
        .rev()
        .find_map(|day| Date::from_calendar_date(year, month, day).ok())
}

fn out_of_range(date: Date) -> KernelError {
    KernelError::validation(format!(
        "연차 사용기간 종료일 {date}에서 §61 기간을 계산할 수 없습니다"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::date;

    fn ctx(track: PromotionTrack, period_end: Date, served_on: Date) -> PromotionContext {
        PromotionContext {
            track,
            period_end,
            served_on,
            first_round_served_on: None,
            second_round_served_on: None,
        }
    }

    #[test]
    fn annual_first_round_window_matches_the_published_fiscal_year_answer() {
        // Fiscal year 1/1–12/31 → first-round urging 7/1 ~ 7/10 (Shopl, MOEL practice).
        let window = first_round_window(PromotionTrack::Annual, date!(2026 - 12 - 31)).unwrap();
        assert_eq!(window.opens_on, date!(2026 - 07 - 01));
        assert_eq!(window.closes_on, date!(2026 - 07 - 10));
    }

    #[test]
    fn annual_second_round_deadline_matches_the_published_fiscal_year_answer() {
        assert_eq!(
            second_round_deadline(PromotionTrack::Annual, date!(2026 - 12 - 31)).unwrap(),
            date!(2026 - 10 - 31)
        );
    }

    #[test]
    fn annual_round_one_boundaries_are_inclusive_and_closed_on_both_sides() {
        let period_end = date!(2026 - 12 - 31);
        // The day before the window opens.
        assert!(
            validate_promotion(
                &ctx(PromotionTrack::Annual, period_end, date!(2026 - 06 - 30)),
                1
            )
            .is_err()
        );
        // First and last valid days.
        assert_eq!(
            validate_promotion(
                &ctx(PromotionTrack::Annual, period_end, date!(2026 - 07 - 01)),
                1
            )
            .unwrap(),
            1
        );
        assert_eq!(
            validate_promotion(
                &ctx(PromotionTrack::Annual, period_end, date!(2026 - 07 - 10)),
                1
            )
            .unwrap(),
            1
        );
        // The day after it closes.
        assert!(
            validate_promotion(
                &ctx(PromotionTrack::Annual, period_end, date!(2026 - 07 - 11)),
                1
            )
            .is_err()
        );
    }

    #[test]
    fn round_two_requires_a_recorded_round_one() {
        let error = validate_promotion(
            &ctx(
                PromotionTrack::Annual,
                date!(2026 - 12 - 31),
                date!(2026 - 10 - 01),
            ),
            2,
        )
        .unwrap_err();
        assert_eq!(error.kind, console_kernel_core::ErrorKind::Conflict);
    }

    #[test]
    fn round_two_waits_out_the_workers_ten_day_reply_window() {
        let mut context = ctx(
            PromotionTrack::Annual,
            date!(2026 - 12 - 31),
            date!(2026 - 07 - 11),
        );
        context.first_round_served_on = Some(date!(2026 - 07 - 01));
        // Day 10 after the urging is still the worker's; day 11 is the employer's.
        context.served_on = date!(2026 - 07 - 11);
        assert!(validate_promotion(&context, 2).is_err());
        context.served_on = date!(2026 - 07 - 12);
        assert_eq!(validate_promotion(&context, 2).unwrap(), 2);
    }

    #[test]
    fn round_two_boundaries_close_on_the_two_month_deadline() {
        let mut context = ctx(
            PromotionTrack::Annual,
            date!(2026 - 12 - 31),
            date!(2026 - 10 - 31),
        );
        context.first_round_served_on = Some(date!(2026 - 07 - 01));
        assert_eq!(validate_promotion(&context, 2).unwrap(), 2);
        context.served_on = date!(2026 - 11 - 01);
        assert!(validate_promotion(&context, 2).is_err());
    }

    #[test]
    fn first_year_early_track_uses_the_three_month_and_one_month_periods() {
        // Joined 2025-03-01 → first year of employment ends 2026-02-28.
        let period_end = date!(2026 - 02 - 28);
        let window = first_round_window(PromotionTrack::FirstYearEarly, period_end).unwrap();
        assert_eq!(window.opens_on, date!(2025 - 11 - 29));
        assert_eq!(window.closes_on, date!(2025 - 12 - 08));
        assert_eq!(
            second_round_deadline(PromotionTrack::FirstYearEarly, period_end).unwrap(),
            date!(2026 - 01 - 28)
        );
    }

    #[test]
    fn first_year_late_track_uses_the_five_day_and_ten_day_periods() {
        let period_end = date!(2026 - 02 - 28);
        let window = first_round_window(PromotionTrack::FirstYearLate, period_end).unwrap();
        assert_eq!(window.opens_on, date!(2026 - 01 - 29));
        assert_eq!(window.closes_on, date!(2026 - 02 - 02), "5일 이내");
        assert_eq!(
            second_round_deadline(PromotionTrack::FirstYearLate, period_end).unwrap(),
            date!(2026 - 02 - 18),
            "끝나기 10일 전까지"
        );
    }

    #[test]
    fn month_subtraction_clamps_to_the_end_of_a_shorter_month() {
        // 2026-03-31 minus one month has no 31st to land on.
        assert_eq!(
            minus_months(date!(2026 - 03 - 31), 1),
            Some(date!(2026 - 02 - 28))
        );
        assert_eq!(
            minus_months(date!(2024 - 03 - 31), 1),
            Some(date!(2024 - 02 - 29))
        );
        // Crossing a year boundary.
        assert_eq!(
            minus_months(date!(2026 - 02 - 15), 3),
            Some(date!(2025 - 11 - 15))
        );
    }

    #[test]
    fn refusal_requires_a_recorded_round_two_and_stays_inside_the_leave_period() {
        let period_end = date!(2026 - 12 - 31);
        let mut context = ctx(PromotionTrack::Annual, period_end, date!(2026 - 12 - 20));
        assert_eq!(
            validate_refusal(&context).unwrap_err().kind,
            console_kernel_core::ErrorKind::Conflict
        );
        context.second_round_served_on = Some(date!(2026 - 10 - 31));
        assert_eq!(validate_refusal(&context).unwrap(), 2);
        context.served_on = date!(2026 - 10 - 30);
        assert!(validate_refusal(&context).is_err(), "before the 2차 통보");
        context.served_on = date!(2027 - 01 - 02);
        assert!(
            validate_refusal(&context).is_err(),
            "after the leave period"
        );
    }

    #[test]
    fn a_round_two_notice_must_actually_designate_dates() {
        let served_on = date!(2026 - 10 - 31);
        let period_end = date!(2026 - 12 - 31);
        assert!(validate_designated_dates(&[], served_on, period_end).is_err());
        assert!(validate_designated_dates(&[date!(2026 - 12 - 24)], served_on, period_end).is_ok());
        assert!(
            validate_designated_dates(&[date!(2026 - 10 - 31)], served_on, period_end).is_err(),
            "the designated day must follow the notice"
        );
        assert!(
            validate_designated_dates(&[date!(2027 - 01 - 04)], served_on, period_end).is_err(),
            "the designated day must fall inside the leave period"
        );
        assert!(
            validate_designated_dates(
                &[date!(2026 - 12 - 24), date!(2026 - 12 - 24)],
                served_on,
                period_end
            )
            .is_err(),
            "duplicates would overstate the days designated"
        );
    }

    #[test]
    fn track_round_trips_through_its_wire_form() {
        for track in [
            PromotionTrack::Annual,
            PromotionTrack::FirstYearEarly,
            PromotionTrack::FirstYearLate,
        ] {
            assert_eq!(PromotionTrack::parse(track.as_str()).unwrap(), track);
        }
        assert!(PromotionTrack::parse("annual_leave").is_err());
    }

    #[test]
    fn round_zero_and_three_are_rejected() {
        let context = ctx(
            PromotionTrack::Annual,
            date!(2026 - 12 - 31),
            date!(2026 - 07 - 01),
        );
        assert!(validate_promotion(&context, 0).is_err());
        assert!(validate_promotion(&context, 3).is_err());
    }
}
