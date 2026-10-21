//! Korean notification copy (copy-conventions.md); domain labels are interpolated.
const COMPANY_DOMAIN_CHANGED: &str =
    "회사 도메인 변경: {from} → {to}. 다음 로그인부터 새 회사 도메인을 사용하십시오.";
pub(crate) fn company_domain_changed(from: &str, to: &str) -> String {
    COMPANY_DOMAIN_CHANGED
        .replace("{from}", from)
        .replace("{to}", to)
}
