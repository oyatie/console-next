// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_settings_domain::code_lists::{parse_domain, validate_reason};
use console_settings_domain::{LooserWhen, SettingKey, SettingValue};

#[test]
fn excess_clocks_are_tenant_settings_with_explicit_defaults() {
    for (wire, default) in [
        ("attendance.excess.disposition_due_days", 3),
        ("attendance.excess.repeat_window_days", 28),
        ("attendance.excess.repeat_count", 3),
    ] {
        let key: SettingKey = wire.parse().unwrap();
        assert_eq!(key.def().default, Some(SettingValue::Int(default)));
        assert_eq!(key.def().looser_when, LooserWhen::Higher);
    }
}

#[test]
fn overtime_method_must_be_chosen_from_the_system_domain() {
    let domain = parse_domain("overtime_approval_method").unwrap();
    assert!(!domain.tenant_extensible());
    for code in ["IN_APP", "WRITTEN", "VERBAL"] {
        assert!(validate_reason(domain, code, None, &[]).is_ok());
    }
    for code in ["", "UNKNOWN", "OTHER"] {
        assert!(validate_reason(domain, code, None, &[]).is_err());
    }
}
