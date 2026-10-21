//! Registration classification is supplied by the versioned NTS reference list.
use crate::Refusal;
use crate::codes::BizKind;

/// An unusual registration may be recorded with an explicit explanation.
pub fn validate_classification(
    kind: Option<BizKind>,
    primary: bool,
    reason: Option<&str>,
    rule: Option<(&[&str], bool)>,
) -> Result<(), Refusal> {
    let fits = rule.is_some_and(|(kinds, head)| {
        kind.is_some_and(|k| kinds.contains(&k.as_str())) && (!primary || head)
    });
    if !fits && reason.is_none_or(|r| r.trim().is_empty()) {
        return Err(Refusal::field(
            "classification_reason",
            "registration_classification_reason_required",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn branch_primary_wrong_kind_and_unknown_need_a_reason() {
        let corp = &["CORPORATION"][..];
        for (kind, primary, rule) in [
            (Some(BizKind::Corporation), true, Some((corp, false))),
            (Some(BizKind::Individual), false, Some((corp, true))),
            (Some(BizKind::Corporation), true, None),
        ] {
            let refusal = validate_classification(kind, primary, None, rule).unwrap_err();
            assert_eq!(
                refusal.fields[0].code,
                "registration_classification_reason_required"
            );
            assert!(validate_classification(kind, primary, Some(""), rule).is_err());
            assert!(
                validate_classification(
                    kind,
                    primary,
                    Some("certificate is for a branch; head-office certificate requested"),
                    rule
                )
                .is_ok()
            );
        }
        assert!(
            validate_classification(Some(BizKind::Corporation), true, None, Some((corp, true)))
                .is_ok()
        );
        assert!(
            validate_classification(Some(BizKind::Corporation), false, None, Some((corp, false)))
                .is_ok()
        );
    }
}
