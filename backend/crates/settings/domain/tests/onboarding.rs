// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use console_settings_domain::{
    Governance, LooserWhen, SettingKey, SettingKind, SettingValue, Unit,
};

#[test]
fn receipt_window_is_a_bounded_day_count_and_zero_disables_it() {
    let key: SettingKey = "onboarding.receipt_days".parse().unwrap();
    let def = key.def();
    assert_eq!(def.default, Some(SettingValue::Int(7)));
    assert_eq!(def.governance, Governance::PlatformOnly);
    assert_eq!(def.looser_when, LooserWhen::Neutral);
    assert_eq!(
        def.kind,
        SettingKind::Int {
            unit: Unit::Days,
            min: Some(0),
            max: Some(365),
        }
    );
    for days in [0, 365] {
        assert!(def.in_range(SettingValue::Int(days)));
    }
    for days in [-1, 366] {
        assert!(!def.in_range(SettingValue::Int(days)));
    }
    for value in [serde_json::json!(1.5), serde_json::json!("7")] {
        assert!(def.parse(&value).is_none());
    }
}
