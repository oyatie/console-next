// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{IssueCertificateRequest, invalid};
use crate::HrError;

pub(super) const ITEMS: &[&str] = &["period", "duty", "position", "wage", "birth"];
pub(super) fn issue(body: &IssueCertificateRequest) -> Result<(), HrError> {
    issue_fields(&body.kind, &body.items, &body.purpose)
}

pub(super) fn issue_fields(kind: &str, items: &[String], purpose: &str) -> Result<(), HrError> {
    if !["EMPLOYMENT", "CAREER", "EXIT"].contains(&kind)
        || items.is_empty()
        || items.len() > ITEMS.len()
        || items.iter().any(|key| !ITEMS.contains(&key.as_str()))
        || items
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != items.len()
    {
        return Err(invalid(
            "choose a certificate kind and distinct requested items",
        ));
    }
    text(purpose, 200)?;
    Ok(())
}
pub(super) fn text(raw: &str, max: usize) -> Result<String, HrError> {
    let text = raw.trim();
    if text.is_empty() || text.chars().count() > max || text.chars().any(char::is_control) {
        return Err(invalid(
            "text is empty, too long, or contains control characters",
        ));
    }
    Ok(text.into())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    #[test]
    fn only_explicit_distinct_requested_fields_are_accepted() {
        let mut b = IssueCertificateRequest {
            employee_id: uuid::Uuid::new_v4(),
            kind: "CAREER".into(),
            items: vec!["period".into()],
            purpose: "제출용".into(),
        };
        assert!(issue(&b).is_ok());
        for keys in [vec![], vec!["birth", "birth"], vec!["raw_row"]] {
            b.items = keys.iter().map(|x| (*x).into()).collect();
            assert_eq!(issue(&b).unwrap_err().code, "certificate_invalid");
        }
        assert!(text("\n", 200).is_err());
        assert!(text("가\u{0000}", 200).is_err());
    }
}
