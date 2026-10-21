//! The 퇴직(해고) 사유 a 근로자 명부 prints for a system `exit_reason` code
//! (영 §20 8호 asks for the 사유, and 근기법 §40 keeps internal codes off the
//! register). Labels are the Korean names of decisions #9 Table A, one per
//! BW-07 roster code; a tenant code prints its own `label_ko`.

/// The register label of a system `exit_reason` code, `None` for any other.
#[must_use]
pub fn exit_reason_label(code: &str) -> Option<&'static str> {
    Some(match code {
        "PERSONAL" => "개인 사정",
        "FAMILY" => "가사",
        "ILLNESS" => "질병",
        "STUDY" => "학업",
        "WORKING_CONDITIONS" => "근로조건 변동",
        "WAGE_ARREARS" => "임금체불",
        "RELOCATION" => "이전",
        "CLOSURE" => "폐업",
        "INSOLVENCY" => "도산",
        "ADVISED_RESIGNATION_BUSINESS" => "권고사직(경영상)",
        "REDUNDANCY_DISMISSAL" => "경영상 해고",
        "DISCIPLINARY_DISMISSAL" => "징계해고",
        "ADVISED_RESIGNATION_FAULT" => "권고사직(귀책)",
        "RETIREMENT_AGE" => "정년",
        "CONTRACT_END" => "계약만료",
        "PROJECT_END" => "공사종료",
        "COVERAGE_EXCLUDED" => "적용 제외",
        "DUAL_EMPLOYMENT" => "이중고용",
        "DEATH" => "사망",
        "OTHER" => "기타",
        _ => return None,
    })
}

/// The 성별 cell of the register: 남 / 여, empty while 미입력.
#[must_use]
pub fn sex_label(code: &str) -> &'static str {
    match code {
        "MALE" => "남",
        "FEMALE" => "여",
        _ => "",
    }
}

/// The 이력 cell when the employee has no prior career (an explicit answer,
/// not 미입력).
pub const CAREER_NONE: &str = "경력 없음";
