pub(super) fn valid_namespaced_id(value: &str) -> bool {
    let Some((kind, id)) = value.split_once(':') else {
        return false;
    };
    let filing = kind
        .strip_prefix("insurance_filing_")
        .and_then(|k| k.rsplit_once('_'))
        .is_some_and(|(kind, insurer)| {
            matches!(
                kind,
                "ACQUIRE"
                    | "LOSE"
                    | "LEAVE"
                    | "RESUME"
                    | "AGE60"
                    | "WORK_CONFIRMATION"
                    | "SEPARATION_CERTIFICATE"
                    | "ACQUIRE_REQUESTED"
                    | "MONTHLY_REMUNERATION"
            ) && matches!(insurer, "NPS" | "NHIS" | "EI" | "IACI")
        });
    (filing
        || matches!(
            kind,
            "approval"
                | "dispatch"
                | "support"
                | "work"
                | "payroll"
                | "governance"
                | "org_change"
                | "hr_exit"
                | "hr_lifecycle"
                | "hr_request"
                | "hr_register"
                | "hr_identity"
                | "hr_branch"
                | "hr_contract"
                | "period_unlock"
                | "grant_notice"
                | "account_security"
                | "setup_entity"
                | "setup_workplace"
                | "setup_org"
                | "setup_approval"
                | "setup_people"
                | "setup_passkey"
                | "setup_employees"
                | "setup_roles"
                | "setup_golive"
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

#[cfg(test)]
mod supplementary_cursor_regressions {
    use super::valid_namespaced_id;

    macro_rules! filing_kind {
        ($name:ident, $kind:literal) => {
            #[test]
            fn $name() {
                for insurer in ["NPS", "NHIS", "EI", "IACI"] {
                    let id = format!(
                        "insurance_filing_{}_{}:00000000-0000-0000-0000-000000000001",
                        $kind, insurer
                    );
                    assert!(
                        valid_namespaced_id(&id),
                        "a known filing must continue: {id}"
                    );
                }
            }
        };
    }

    filing_kind!(acquisition_cursor, "ACQUIRE");
    filing_kind!(loss_cursor, "LOSE");
    filing_kind!(leave_cursor, "LEAVE");
    filing_kind!(resume_cursor, "RESUME");
    filing_kind!(birthday_cursor, "AGE60");
    filing_kind!(work_confirmation_cursor, "WORK_CONFIRMATION");
    filing_kind!(separation_certificate_cursor, "SEPARATION_CERTIFICATE");
    filing_kind!(requested_acquisition_cursor, "ACQUIRE_REQUESTED");
    filing_kind!(monthly_remuneration_cursor, "MONTHLY_REMUNERATION");

    #[test]
    fn supplementary_cursor_refuses_unknown_kinds_agencies_and_malformed_boundaries() {
        for prefix in [
            "WORK_CONFIRMATION_OTHER",
            "UNKNOWN_CASE_EI",
            "_EI",
            "WORK_CONFIRMATION_",
            "WORK_CONFIRMATION_EI_EXTRA",
            "WORK_CONFIRMATION_EXTRA_EI",
        ] {
            assert!(
                !valid_namespaced_id(&format!(
                    "insurance_filing_{prefix}:00000000-0000-0000-0000-000000000001"
                )),
                "{prefix}"
            );
        }
        for suffix in [
            "not-a-uuid",
            "",
            "00000000-0000-0000-0000-000000000001:extra",
        ] {
            assert!(
                !valid_namespaced_id(&format!("insurance_filing_WORK_CONFIRMATION_EI:{suffix}")),
                "{suffix}"
            );
        }
    }
}
