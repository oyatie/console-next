// SPDX-License-Identifier: LicenseRef-Proprietary

use console_kernel_core::{EffectivePeriod, KernelError};
use time::Date;
use time::macros::date;

use crate::{Instrument, statutory_instruments_retrieved_on};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MinimumWageRate {
    pub period: EffectivePeriod,
    pub hourly_won: i64,
    /// 10,320 × 8. OURS, not the Minister's — the 고시 carries no daily figure.
    pub daily_8h_won: i64,
    pub monthly_209h_won: i64,
    pub instrument: Instrument,
}

#[must_use]
pub fn minimum_wage_rates() -> Vec<MinimumWageRate> {
    vec![
        MinimumWageRate {
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            hourly_won: 10_320,
            daily_8h_won: 82_560,
            monthly_209h_won: 2_156_880,
            instrument: Instrument {
                name_ko: "2026년 적용 최저임금 고시",
                article_ko: "1. 모든 산업 시간급 10,320원 · 월환산액 2,156,880원(209시간) · 2. 사업의 종류별 구분 없이 모든 사업장에 동일하게 적용 · 3. 적용기간 2026.1.1.~2026.12.31.",
                promulgation_ko: "고용노동부고시 제2025-47호 (발령 2025. 8. 5.)",
                enforced_on: date!(2026 - 01 - 01),
                url: "https://www.law.go.kr/행정규칙/2026년 적용 최저임금 고시",
                retrieved_on: statutory_instruments_retrieved_on(),
            },
        },
        MinimumWageRate {
            period: EffectivePeriod::new(date!(2027 - 01 - 01), Some(date!(2028 - 01 - 01))),
            hourly_won: 10_700,
            daily_8h_won: 85_600,
            monthly_209h_won: 2_236_300,
            instrument: Instrument {
                name_ko: "2027년 적용 최저임금 고시",
                article_ko: "1. 모든 산업 시간급 10,700원 · 월환산액 2,236,300원(209시간) · 2. 사업의 종류별 구분 없이 모든 사업장에 동일하게 적용, 도급제 근로자에 대해 별도 적용하지 않음 · 3. 적용기간 2027.1.1.~2027.12.31.",
                promulgation_ko: "고용노동부고시 제2026-60호 (발령 2026. 8. 5.)",
                enforced_on: date!(2027 - 01 - 01),
                url: "https://www.law.go.kr/LSW/admRulInfoR.do?admRulSeq=2100000283564",
                // Read directly from law.go.kr admRulSeq=2100000283564 (발령 2026-08-05, 시행 2027-01-01, flSeq=167847381) on 2026-10-20 UTC.
                retrieved_on: date!(2026 - 10 - 20),
            },
        },
    ]
}

pub fn minimum_wage_on(day: Date) -> Result<MinimumWageRate, KernelError> {
    minimum_wage_rates()
        .into_iter()
        .find(|rate| rate.period.contains(day))
        .ok_or_else(|| KernelError::validation(format!("missing minimum wage for {day}")))
}
