pub(super) fn valid_namespaced_id(value: &str) -> bool {
    let Some((kind, id)) = value.split_once(':') else {
        return false;
    };
    let filing = kind
        .strip_prefix("insurance_filing_")
        .and_then(|k| k.split_once('_'))
        .is_some_and(|(kind, insurer)| {
            matches!(kind, "ACQUIRE" | "LOSE" | "LEAVE" | "RESUME")
                && matches!(insurer, "NPS" | "NHIS" | "EI" | "IACI")
        });
    (filing
        || matches!(
            kind,
            "approval"
                | "dispatch"
                | "support"
                | "support_access"
                | "work"
                | "payroll"
                | "governance"
                | "org_change"
                | "hr_exit"
                | "hr_lifecycle"
                | "hr_request"
                | "hr_register"
        ))
        && uuid::Uuid::parse_str(id).is_ok()
}

#[cfg(test)]
mod tests {
    use super::valid_namespaced_id;
    #[test]
    fn filing_cursor_identity_accepts_only_known_kinds_agencies_and_uuid() {
        for kind in ["ACQUIRE", "LOSE", "LEAVE", "RESUME"] {
            for insurer in ["NPS", "NHIS", "EI", "IACI"] {
                assert!(valid_namespaced_id(&format!(
                    "insurance_filing_{kind}_{insurer}:00000000-0000-0000-0000-000000000001"
                )));
            }
        }
        for value in [
            "insurance_filing_ACQUIRE_OTHER:00000000-0000-0000-0000-000000000001",
            "insurance_filing_OTHER_NPS:00000000-0000-0000-0000-000000000001",
            "insurance_filing_ACQUIRE_NPS:not-a-uuid",
            "insurance_filing_ACQUIRE_NPS_extra:00000000-0000-0000-0000-000000000001",
        ] {
            assert!(!valid_namespaced_id(value));
        }
    }
}
