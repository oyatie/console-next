// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{EffectivePeriod, Instrument, MonthlyPremiumClamp, statutory_instruments_retrieved_on};
use console_kernel_core::KernelError;
use time::{Date, macros::date};

#[must_use]
pub fn health_premium_bands() -> Vec<(EffectivePeriod, MonthlyPremiumClamp)> {
    vec![(
        EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
        MonthlyPremiumClamp {
            floor_won: 20_160,
            cap_won: 9_183_480,
            instrument: Instrument {
                name_ko: "월별 건강보험료액의 상한과 하한에 관한 고시",
                article_ko: "직장가입자의 보수월액보험료 — 상한 9,183,480원 / 하한 20,160원",
                promulgation_ko: "보건복지부고시 제2025-222호 (발령 2025. 12. 24.)",
                enforced_on: date!(2026 - 01 - 01),
                url: "https://www.law.go.kr/LSW/admRulInfoR.do?admRulSeq=2100000270472",
                retrieved_on: statutory_instruments_retrieved_on(),
            },
        },
    )]
}

pub fn health_premium_band_on(day: Date) -> Result<MonthlyPremiumClamp, KernelError> {
    health_premium_bands()
        .into_iter()
        .find(|(period, _)| period.contains(day))
        .map(|(_, band)| band)
        .ok_or_else(|| KernelError::validation(format!("HEALTH_PREMIUM_BAND_MISSING: {day}")))
}
