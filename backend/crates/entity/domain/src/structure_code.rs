//! 부서 코드 and 사업장 code (G5, review R16): one rule for both, the same
//! as the org change's `check_unit_code` (1-30 letters, digits, `.`, `_`,
//! `-`; matched exactly), so a code set in setup stays valid after go-live.

use crate::Refusal;

/// Longest code (a storage bound, not a tenant policy).
pub const CODE_MAX_CHARS: usize = 30;

/// `None` or blank clears the code; anything else must fit the rule.
///
/// # Errors
/// `{field}: invalid_format`.
pub fn structure_code(field: &str, raw: Option<&str>) -> Result<Option<String>, Refusal> {
    let Some(code) = raw.map(str::trim).filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    let valid = code.chars().count() <= CODE_MAX_CHARS
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(Some(code.to_owned()))
    } else {
        Err(Refusal::field(field, "invalid_format"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_follow_the_org_change_rule() {
        assert_eq!(
            structure_code("code", Some(" P-01 ")).unwrap().as_deref(),
            Some("P-01")
        );
        assert_eq!(structure_code("code", Some("  ")).unwrap(), None);
        assert_eq!(structure_code("code", None).unwrap(), None);
        assert!(structure_code("code", Some(&"A".repeat(30))).is_ok());
        for bad in ["A".repeat(31), "생산1".into(), "a b".into(), "a/b".into()] {
            assert!(structure_code("code", Some(&bad)).is_err(), "{bad}");
        }
    }
}
