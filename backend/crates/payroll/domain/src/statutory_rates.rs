// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    ContributionBasis, ContributionCode, EffectivePeriod, HALF_SHARE_ROUNDING, Instrument,
    NO_FRACTION_RULE_IN_COLLECTION_ACT, Rounding, RoundingUnit, ShareRule, StatutoryRate,
    employment_insurance_rate_instrument, fifty_fifty_share_instrument,
    long_term_care_fraction_instrument, long_term_care_half_share_instrument,
    national_pension_fraction_instrument, national_pension_rate_instrument,
    national_treasury_fraction_instrument, statutory_instruments_retrieved_on,
};
use time::macros::date;

#[must_use]
pub fn statutory_contribution_rates() -> Vec<StatutoryRate> {
    let mut rates = vec![
        StatutoryRate {
            code: ContributionCode::NationalPension,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            basis: ContributionBasis::MonthlyStandardIncome,
            // 1만분의 475 = 4.75%, the employee share directly: there is no
            // total-then-halve step for 국민연금.
            rate_num: 475,
            rate_den: 10_000,
            // 단수 rule: LOCATED. 국민연금법 제117조 준용s 국고금관리법 for
            // 연금보험료, exactly as 국민건강보험법 제107조 does for 건강보험.
            // An earlier round recorded this bridge as absent and emitted the
            // unrounded product as a disclosed assumption; the article exists
            // and is in force, so the assumption is retired.
            total_rounding: Rounding::Resolved {
                unit: RoundingUnit::Trunc10,
                instrument: national_pension_fraction_instrument(),
            },
            employee_share: ShareRule::WholeOfRate,
            clamp_required: false,
            instrument: national_pension_rate_instrument(),
            share_instrument: None,
            provenance: "레지스터 §1 항목 1에서 부칙 조문 전문을 인용(시행 중인 파일에서 읽음, HIGH). 연간 고시가 아니라 법률 부칙의 2026→2032 법정 스케줄. 10원 미만 절사의 근거는 국민연금법 제117조(단수의 처리)가 국고금관리법을 준용하는 데 있다 — 법령ID 001781, MST 280269, efYd 20260101(법률 제21203호)로 슬라이스를 고정해 조문 전문을 읽었다. 종전의 「규정 미발견에 따른 공개 가정」은 철회. 종전 인용 2026-06-17은 같은 MST의 나중 슬라이스였다: MST 280269는 20260101·20260617 두 시행일을 가지며 efYd를 고정하지 않으면 나중 것이 온다. 응답에 함께 실리는 조문시행일자는 요청한 슬라이스를 되받는 값이므로 별개의 증거가 아니다.",
        },
        StatutoryRate {
            code: ContributionCode::HealthInsurance,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            basis: ContributionBasis::MonthlyRemuneration,
            rate_num: 719,
            rate_den: 10_000,
            total_rounding: Rounding::Resolved {
                unit: RoundingUnit::Trunc10,
                instrument: national_treasury_fraction_instrument(),
            },
            employee_share: ShareRule::Half {
                rounding: HALF_SHARE_ROUNDING,
            },
            clamp_required: true,
            instrument: Instrument {
                name_ko: "국민건강보험법 시행령",
                article_ko: "제44조제1항 「법 제73조제1항에 따른 직장가입자의 보험료율 … 은 각각 1만분의 719로 한다」 <개정 2025.12.23>",
                // The row is in force from 2026-01-01, so its instrument must be
                // the one in force THEN. 제36116호 (시행 2026-02-19) did not touch
                // 제44조 — its 개정 history ends 2025.12.23 — and citing it dated
                // the rate seven weeks after the row it justifies.
                promulgation_ko: "대통령령 제35931호",
                enforced_on: date!(2026 - 01 - 01),
                url: "https://www.law.go.kr/법령/국민건강보험법시행령",
                retrieved_on: statutory_instruments_retrieved_on(),
            },
            share_instrument: Some(fifty_fifty_share_instrument()),
            provenance: "요율은 2026-01-01 시행본을 eflaw로 직접 읽음 (법령ID 002813, MST 280453, 대통령령 제35931호) — 제44조제1항의 최종 개정은 2025.12.23이며 제36116호(시행 2026-02-19)는 이 조문을 건드리지 않았다. 종전 인용 「제36116호, 시행 2026-02-19」은 이 행의 effective_from(2026-01-01)보다 7주 늦은 문서였다. 50/50 분담(제76조제1항)과 10원 절사(제107조)는 이 행의 effective_from에 시행 중인 슬라이스에서 읽음 — MST 265877, efYd 20250423, 법률 제20505호. 종전 인용 「법률 제21065호」는 시행 2026-01-02로 이 행보다 하루 늦은 슬라이스였다. 총액은 10원 절사 후 상·하한 고시로 클램프하며, 절반 분담의 반올림 단위는 미해결(Q-HALF-SHARE-ROUNDING-UNIT).",
        },
        // 장기요양's basis is the 건강보험료액, and its ratio is EXACT
        // (9,448/71,900) until 제9조제1항's 반올림 clause enters force.
        StatutoryRate {
            code: ContributionCode::LongTermCare,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2026 - 11 - 27))),
            basis: ContributionBasis::HealthInsurancePremium,
            rate_num: 9_448,
            rate_den: 71_900,
            // The 준용 article, not the destination: 장기요양 reaches 제107조 only
            // through 노인장기요양보험법 제64조, and the destination alone is a
            // citation only a reader who already knows the chain can check.
            total_rounding: Rounding::Resolved {
                unit: RoundingUnit::Trunc10,
                instrument: long_term_care_fraction_instrument(),
            },
            employee_share: ShareRule::Half {
                rounding: HALF_SHARE_ROUNDING,
            },
            clamp_required: false,
            instrument: Instrument {
                name_ko: "노인장기요양보험법 시행령",
                article_ko: "제4조(장기요양보험료율) 「법 제9조제1항에 따른 장기요양보험료율은 100만분의 9,448로 한다」 <개정 2025.12.30>",
                // Same defect as 건강보험 above: 제36325호 is enforced 2026-05-12,
                // four months after this row starts. 제4조's own 개정 ends
                // 2025.12.30 — 제35987호.
                promulgation_ko: "대통령령 제35987호",
                enforced_on: date!(2026 - 01 - 01),
                url: "https://www.law.go.kr/법령/노인장기요양보험법시행령",
                retrieved_on: statutory_instruments_retrieved_on(),
            },
            share_instrument: Some(long_term_care_half_share_instrument()),
            provenance: "요율은 2026-01-01 시행본을 eflaw로 직접 읽음 (법령ID 010526, MST 281843, 대통령령 제35987호) — 제4조의 최종 개정은 2025.12.30이다. 종전 인용 「제36325호, 시행 2026-05-12」은 이 행의 effective_from보다 넉 달 늦은 문서였다. 산정기초는 보수월액이 아니라 건강보험료액. 제9조제1항 2026-05-26 시행본에는 「소수점 이하 다섯째자리에서 반올림」 문구가 없으므로 비율은 절사·반올림 없이 정확분수 — 그 문구는 법률 제21690호의 2026-11-27 시행분에서 삽입된다. 절사와 50/50 분담은 국민건강보험법을 직접 인용하지 않고 준용 조문을 인용한다: 노인장기요양보험법 제64조(→ 법 제107조), 제11조(→ 법 제76조제1항). 둘 다 법령ID 010436, MST 281921, efYd 20251230, 법률 제21257호에서 읽음.",
        },
        StatutoryRate {
            code: ContributionCode::LongTermCare,
            period: EffectivePeriod::new(date!(2026 - 11 - 27), Some(date!(2027 - 01 - 01))),
            basis: ContributionBasis::HealthInsurancePremium,
            // 0.009448 / 0.0719 = 0.1314047287899… → 0.1314 at 4 dp.
            rate_num: 1_314,
            rate_den: 10_000,
            total_rounding: Rounding::Resolved {
                unit: RoundingUnit::Trunc10,
                instrument: long_term_care_fraction_instrument(),
            },
            employee_share: ShareRule::Half {
                rounding: HALF_SHARE_ROUNDING,
            },
            clamp_required: false,
            instrument: Instrument {
                name_ko: "노인장기요양보험법",
                article_ko: "제9조제1항 (… 비율을 곱하여 산정 <소수점 이하 다섯째자리에서 반올림한다>)",
                promulgation_ko: "법률 제21690호",
                enforced_on: date!(2026 - 11 - 27),
                url: "https://www.law.go.kr/법령/노인장기요양보험법",
                retrieved_on: statutory_instruments_retrieved_on(),
            },
            share_instrument: Some(long_term_care_half_share_instrument()),
            provenance: "동일 공포번호(제21690호)의 두 시행일 슬라이스 중 나중 것. target=law은 이 텍스트를 오늘 이미 반환하므로, 시행일 기준 선택이 없으면 4개월 앞당겨 적용되는 오류가 난다. 절사·분담은 준용 조문(제64조·제11조)을 인용하며, 이 행이 도는 20261127 슬라이스(MST 286217, 법률 제21690호)에서 제11조는 자구까지 동일하고 제64조는 제91조의2·제척기간이 추가되었을 뿐 「제107조 … 단수처리 … 준용한다」는 그대로다.",
        },
        StatutoryRate {
            code: ContributionCode::EmploymentUnemployment,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            basis: ContributionBasis::MonthlyRemuneration,
            // 1천분의 18 total, employee bears ½ → 9/1,000.
            rate_num: 9,
            rate_den: 1_000,
            // 단수 rule: STILL NONE LOCATED, and no longer "same as 국민연금" —
            // 국민연금 has 제117조. `Assumed`, not `Resolved`: 시행령
            // 제12조제1항제2호 sets a RATE and prescribes no 단수 rule, so citing
            // it as the instrument that settles the rounding was a citation
            // that did not match what it cited.
            total_rounding: Rounding::Assumed {
                unit: RoundingUnit::ExactWon,
                note_ko: NO_FRACTION_RULE_IN_COLLECTION_ACT,
            },
            employee_share: ShareRule::WholeOfRate,
            clamp_required: false,
            instrument: employment_insurance_rate_instrument(),
            share_instrument: None,
            provenance: "레지스터 §1 항목 5. 근로자 ½ 부담은 2026-08-01 시행본(법률 제19209호, MST 247481, efYd 20240101)에서 제13조제2항 전문을 직접 읽어 확인 — 「고용보험 가입자인 근로자가 부담하여야 하는 고용보험료는 자기의 보수총액에 제14조제1항에 따른 실업급여의 보험료율의 2분의 1을 곱한 금액으로 한다」. 레지스터의 MEDIUM은 해소됨. 단수는 Rounding::Assumed — 국민연금과 달리 절사 근거 조문이 없다. 시행령 제12조제1항제2호는 요율만 정하며 단수를 정하지 않으므로 그것을 절사 근거로 인용하지 않는다. 2026-08-01 재확인: 단수·끝수는 징수법 본문(MST 247481, efYd 20240101)과 시행령(MST 280527, efYd 20251223) 양쪽 모두 0건이고, 국고금은 시행령 제41조의5제2항제1호의 완납증명 예외(「국고금 관리법 시행령」 제31조 관서운영경비) 한 건뿐이라 단수와 무관하다. 절사 근거 없는 공개 가정으로 남는 것은 여기와 산재뿐이다(오차 <10원).",
        },
        StatutoryRate {
            code: ContributionCode::IndustrialAccident,
            period: EffectivePeriod::new(date!(2026 - 01 - 01), Some(date!(2027 - 01 - 01))),
            basis: ContributionBasis::IndustryTariff,
            rate_num: 0,
            rate_den: 1,
            // 국민건강보험법 제107조 has no application to 산재보험료: it is not
            // reached from 징수법 by any 준용, and 징수법 itself has no 단수
            // article. The earlier citation of it here was a statute that does
            // not govern this row.
            total_rounding: Rounding::Assumed {
                unit: RoundingUnit::ExactWon,
                note_ko: NO_FRACTION_RULE_IN_COLLECTION_ACT,
            },
            employee_share: ShareRule::EmployerOnly,
            clamp_required: false,
            instrument: Instrument {
                name_ko: "고용보험 및 산업재해보상보험의 보험료징수 등에 관한 법률",
                // 제13조제5항 본문 전문. 「사업주가 전액 부담한다」는 조문에 없는
                // 표현이므로 인용하지 않는다 — 근로자 공제가 없다는 결론은
                // 제13조제5항이 산재보험료를 사업주 부담으로만 산정하고
                // 제13조제2항이 근로자에게 고용보험료만 지우는 데서 나온다.
                article_ko: "제13조제5항 「제1항에 따라 사업주가 부담하여야 하는 산재보험료는 그 사업주가 경영하는 사업에 종사하는 근로자의 개인별 보수총액에 다음 각 호에 따른 산재보험료율을 곱한 금액을 합한 금액으로 한다」 — 근로자 부담분을 정한 항이 없다. 요율은 고용노동부고시 제2025-91호 별지, 유효기간 2026-12-31",
                promulgation_ko: "법률 제19209호",
                enforced_on: date!(2024 - 01 - 01),
                url: "https://www.law.go.kr/법령/고용보험및산업재해보상보험의보험료징수등에관한법률",
                retrieved_on: statutory_instruments_retrieved_on(),
            },
            share_instrument: None,
            provenance: "rate_num=0은 근로자 요율이며(징수법에 근로자 산재 부담 조항 없음) 사업주 부담액이 아니다 — 사업주 총액은 별지 미파싱으로 미상이며 커널은 이를 0이 아닌 NULL로 낸다. 2026-08-01 시행본을 eflaw 2단계로 확정하여 조문 전문을 읽음 (MST 247481, efYd 20240101). 이 법령명한글로 target=eflaw lawSearch를 display=100으로 1·2면 모두 열거하면(totalCnt 174) 정확히 일치하는 행이 56건이고 그중 시행예정은 20261008·20270101 둘뿐이다 — 종전에 적힌 「58개 슬라이스」는 재현되지 않아 실측치로 대체한다(56행 = 서로 다른 시행일자 48개, 서로 다른 MST 38개). 종전 인용 「법률 제21532호, 시행 2026-10-08」은 장래효 슬라이스였고, 종전 article_ko는 인용이 아니라 의역이었다 — 둘 다 정정. 단수는 Rounding::Assumed — 종전에는 국민건강보험법 제107조를 인용했으나 그 조문은 같은 법 「보험료등」에만 미치고 징수법이 이를 준용하는 조항이 없어, 산재보험료에 적용되지 않는 법률을 인용한 것이었다.",
        },
    ];
    let period = EffectivePeriod::new(date!(2027 - 01 - 01), Some(date!(2028 - 01 - 01)));
    let pension = Instrument {
        article_ko: "부칙 <법률 제20903호> 제4조제1항제2호: 2027년은 1만분의 500",
        promulgation_ko: "법률 제22096호",
        enforced_on: period.from,
        url: "https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=291347&efYd=20270101",
        retrieved_on: date!(2026 - 10 - 27),
        ..rates[0].instrument
    };
    let health_act = Instrument {
        promulgation_ko: "법률 제21687호",
        enforced_on: period.from,
        url: "https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=286213&efYd=20270101",
        retrieved_on: date!(2026 - 10 - 27),
        ..fifty_fifty_share_instrument()
    };
    let collection_act = Instrument {
        article_ko: "제13조제2항: 근로자가 자기의 보수에 실업급여 보험료율의 2분의 1을 곱한 금액을 부담",
        promulgation_ko: "법률 제21472호",
        enforced_on: period.from,
        url: "https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=284441&efYd=20270101",
        retrieved_on: date!(2026 - 10 - 27),
        ..rates[5].instrument
    };
    rates.extend([
        StatutoryRate {
            period, rate_num: 500, instrument: pension,
            total_rounding: Rounding::Resolved { unit: RoundingUnit::Trunc10, instrument: Instrument { article_ko: national_pension_fraction_instrument().article_ko, ..pension } },
            provenance: "2026-10-27 LSW 20270101 시행본(법률 제22096호)을 읽음. 부칙 <법률 제20903호> 제4조제1항제2호 500/10000, 제117조의 10원 미만 단수 처리 확인. 연간 재검토 경계 2028-01-01, CTRL-KR-WORKFORCE-001 HOLD.",
            ..rates[0]
        },
        StatutoryRate {
            period,
            instrument: Instrument {
                article_ko: "제44조제1항: 직장가입자와 지역가입자의 보험료율은 각각 1만분의 719",
                promulgation_ko: "대통령령 제36675호", enforced_on: period.from,
                url: "https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=289701&efYd=20270101", retrieved_on: date!(2026-10-27),
                ..rates[1].instrument
            },
            total_rounding: Rounding::Resolved { unit: RoundingUnit::Trunc10, instrument: Instrument { article_ko: national_treasury_fraction_instrument().article_ko, ..health_act } },
            share_instrument: Some(health_act),
            provenance: "2026-10-27 LSW 20270101 시행본을 읽음. 대통령령 제36675호 제44조제1항 719/10000, 법률 제21687호 제76조제1항 분담·제107조 끝수 확인. 2027 상·하한 고시 UNVERIFIED: 밴드가 없으면 HEALTH_PREMIUM_BAND_MISSING. CTRL-KR-WORKFORCE-001 HOLD.",
            ..rates[1]
        },
        StatutoryRate {
            period,
            instrument: Instrument { url: "https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=280527&efYd=20251223", retrieved_on: date!(2026-10-27), ..rates[4].instrument },
            share_instrument: Some(collection_act),
            provenance: "2026-10-27 LSW lsHstListR.do?lsId=009842 재확인: 최신 시행령 제35935호(20251223) 제12조제1항제2호 18/1000, 근로자 9/1000. 법률 제21472호 20270101 제13조제2항의 보수·2분의 1 부담 확인. 고용노동부 발표 https://www.moel.go.kr/news/enews/report/enewsView.do?news_seq=19866 의 2027 총 2.0%는 미공포 UNVERIFIED; 2026-12-24 재확인 만료. CTRL-KR-WORKFORCE-001 HOLD.",
            ..rates[4]
        },
        StatutoryRate {
            period,
            instrument: Instrument { article_ko: "제13조제5항: 사업주가 근로자의 개인별 보수에 산재보험료율을 곱한 금액을 부담 — 근로자 부담 조항 없음. 2027 사업종류별 요율 고시 미발견(UNVERIFIED)", ..collection_act },
            provenance: "2026-10-27 LSW 법률 제21472호 20270101 제13조제5항 확인. 0/1은 근로자 부담만 뜻하며 사업주 금액은 NULL. 2027 사업종류별 요율 고시는 미발견 UNVERIFIED, 사업주 요율 미탑재. CTRL-KR-WORKFORCE-001 HOLD.",
            ..rates[5]
        },
    ]);
    rates
}
