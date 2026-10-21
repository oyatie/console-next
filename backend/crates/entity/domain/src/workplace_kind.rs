//! 사업장 kind (decisions #18): a label from a tenant-editable code list. It
//! changes no rule. The platform defaults are these codes; their labels live
//! in the ko/en catalogs. A tenant adds its own kinds (server-generated UUID
//! codes, its own label) and may relabel or hide a default.

use crate::Refusal;

/// The platform defaults, in picker order: 본사, 사업장, 공장, 지점, 영업소,
/// 연구소, 물류센터, 매장.
pub const PLATFORM_KINDS: [&str; 8] = [
    "HEAD_OFFICE",
    "WORKPLACE",
    "FACTORY",
    "BRANCH",
    "SALES_OFFICE",
    "RESEARCH_LAB",
    "LOGISTICS_CENTER",
    "STORE",
];

/// Longest label, in characters.
pub const LABEL_MAX: usize = 40;

#[must_use]
pub fn is_platform(code: &str) -> bool {
    PLATFORM_KINDS.contains(&code)
}

/// A tenant label: trimmed, 1..=40 characters.
///
/// # Errors
/// `label: required` or `label: too_long`.
pub fn label(raw: Option<&str>) -> Result<String, Refusal> {
    let value = raw.map(str::trim).unwrap_or_default();
    if value.is_empty() {
        return Err(Refusal::field("label", "required"));
    }
    if value.chars().count() > LABEL_MAX {
        return Err(Refusal::field("label", "too_long"));
    }
    Ok(value.to_owned())
}

/// A code a 사업장 may name, before the tenant list is consulted: a platform
/// code, or the shape of a tenant code (a UUID). `None` (미지정) passes.
///
/// # Errors
/// `kind_code: invalid_choice`.
pub fn code_shape(raw: Option<&str>) -> Result<Option<String>, Refusal> {
    let Some(code) = raw.map(str::trim) else {
        return Ok(None);
    };
    if is_platform(code) || uuid::Uuid::parse_str(code).is_ok_and(|u| u.to_string() == code) {
        Ok(Some(code.to_owned()))
    } else {
        Err(Refusal::field("kind_code", "invalid_choice"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_trimmed_and_bounded() {
        assert_eq!(label(Some("  창고 ")).unwrap(), "창고");
        assert!(label(None).is_err());
        assert!(label(Some("   ")).is_err());
        assert!(label(Some(&"가".repeat(40))).is_ok());
        assert!(label(Some(&"가".repeat(41))).is_err());
    }

    #[test]
    fn codes_are_platform_defaults_or_tenant_uuids() {
        assert_eq!(code_shape(None).unwrap(), None);
        assert_eq!(
            code_shape(Some("FACTORY")).unwrap().as_deref(),
            Some("FACTORY")
        );
        let tenant = uuid::Uuid::new_v4().to_string();
        assert_eq!(code_shape(Some(&tenant)).unwrap(), Some(tenant.clone()));
        assert!(code_shape(Some("factory")).is_err());
        assert!(code_shape(Some("TEAM")).is_err());
        assert!(code_shape(Some(&tenant.to_uppercase())).is_err());
        assert_eq!(PLATFORM_KINDS.len(), 8);
    }
}
