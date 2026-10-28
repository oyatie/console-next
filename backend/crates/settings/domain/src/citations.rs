//! Citations for keys with a legal bound or a fixed legal value. Sources and
//! URLs are the ones `design/audit/decisions.md` records as verified on
//! 2026-10-01; a key whose source has no verified URL there carries none.
//! Re-check every article against law.go.kr before launch (ST-1).

use console_kernel_core::OfficialSource;
use time::macros::date;

const fn source(authority: &'static str, title: &'static str, url: &'static str) -> OfficialSource {
    OfficialSource {
        authority,
        title,
        url,
        retrieved_on: date!(2026 - 10 - 01),
    }
}

const NATIONAL_ASSEMBLY: &str = "National Assembly of Korea";
const PIPC: &str = "Personal Information Protection Commission";

pub const COMMERCIAL_ACT_393: OfficialSource = source(
    NATIONAL_ASSEMBLY,
    "상법 제393조제1항",
    "https://casenote.kr/법령/상법/제393조",
);
pub const COMMERCIAL_ACT_383: OfficialSource = source(
    NATIONAL_ASSEMBLY,
    "상법 제383조제1항 단서, 제6항",
    "https://casenote.kr/법령/상법/제383조",
);
pub const INCOME_TAX_ACT_128: OfficialSource = source(
    NATIONAL_ASSEMBLY,
    "소득세법 제128조",
    "https://casenote.kr/법령/소득세법/제128조",
);
pub const NIST_800_63B_4: OfficialSource = source(
    "NIST",
    "SP 800-63B-4 (AAL2 inactivity timeout)",
    "https://pages.nist.gov/800-63-4/sp800-63b.html",
);
pub const SAFETY_MEASURES_NOTICE_4: OfficialSource = source(
    PIPC,
    "개인정보의 안전성 확보조치 기준 제4조제4항",
    "https://www.law.go.kr/행정규칙/개인정보의안전성확보조치기준",
);
pub const SAFETY_MEASURES_NOTICE_5: OfficialSource = source(
    PIPC,
    "개인정보의 안전성 확보조치 기준 제5조제3항",
    "https://www.law.go.kr/행정규칙/개인정보의안전성확보조치기준",
);
/// 고시 제2025-9호 §8①: the base period is 1 year; 단서 2호 requires 2 years
/// for 고유식별정보 or 민감정보. Production's floor rests on 민감정보 processing.
pub const SAFETY_MEASURES_NOTICE_8: OfficialSource = source(
    PIPC,
    "개인정보의 안전성 확보조치 기준 제8조제1항제2호",
    "https://www.law.go.kr/행정규칙/개인정보의안전성확보조치기준",
);
pub const STANDARD_PRIVACY_GUIDELINE_10: OfficialSource = source(
    PIPC,
    "표준 개인정보 보호지침 제10조제1항",
    "https://www.law.go.kr/행정규칙/표준개인정보보호지침",
);
pub const LABOR_STANDARDS_DECREE_22: OfficialSource = source(
    NATIONAL_ASSEMBLY,
    "근로기준법 제42조, 같은 법 시행령 제22조",
    "https://www.law.go.kr/법령/근로기준법시행령",
);
pub const BASIC_NATIONAL_TAX_ACT_85_3: OfficialSource = source(
    NATIONAL_ASSEMBLY,
    "국세기본법 제85조의3제2항",
    "https://www.law.go.kr/법령/국세기본법",
);
/// 위탁자 must disclose the 위탁 업무 and the 수탁자 (via the 처리방침, §30).
pub const PIPA_26_2: OfficialSource = source(
    NATIONAL_ASSEMBLY,
    "개인정보 보호법 제26조제2항",
    "https://www.law.go.kr/법령/개인정보보호법",
);
pub const HEALTH_INSURANCE_ACT_96_4: OfficialSource = source(
    NATIONAL_ASSEMBLY,
    "국민건강보험법 제96조의4제2항",
    "https://casenote.kr/법령/국민건강보험법",
);

/// Working-time context; the confirmation threshold is employer policy, not a legal work cap.
pub const LABOR_STANDARDS_ACT_50_53: OfficialSource = source(
    NATIONAL_ASSEMBLY,
    "근로기준법 제50조, 제53조 (기록 확인 기준은 법정 근로시간 한도가 아님)",
    "https://www.law.go.kr/법령/근로기준법",
);
