//! Korean notification copy (copy-conventions.md); domain labels are interpolated.
const COMPANY_DOMAIN_CHANGED: &str =
    "회사 도메인 변경: {from} → {to}. 다음 로그인부터 새 회사 도메인을 사용하십시오.";
pub(crate) fn company_domain_changed(from: &str, to: &str) -> String {
    COMPANY_DOMAIN_CHANGED
        .replace("{from}", from)
        .replace("{to}", to)
}

pub(crate) fn ops_recovery_notice(action: &str) -> &'static str {
    match action {
        "issue" => {
            "운영 계정(ops) 복구 코드가 발급되었습니다. 이전 패스키와 세션은 만료되었습니다. 계정에서 복구 기록을 확인하십시오."
        }
        "cancel" => "운영 계정(ops) 복구 요청이 취소되었습니다. 계정에서 복구 기록을 확인하십시오.",
        _ => {
            "운영 계정(ops) 복구 요청이 접수되었습니다. 본인이 요청하지 않았다면 계정에서 복구 요청을 취소하십시오."
        }
    }
}
