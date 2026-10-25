// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_settings_domain::{Direction, SettingKey, SettingValue, check_change};

#[test]
fn org_change_apply_time_has_a_vendor_default_and_refuses_invalid_minutes() {
    let key: SettingKey = "orgchange.apply_time".parse().unwrap();
    assert_eq!(key.def().default, Some(SettingValue::Int(5)));
    for value in [0, 1439] {
        assert!(key.def().in_range(SettingValue::Int(value)));
    }
    for value in [-1, 1440] {
        assert!(!key.def().in_range(SettingValue::Int(value)));
    }
    assert!(key.def().parse(&serde_json::json!("00:05")).is_none());
}

#[test]
fn moving_the_apply_clock_later_is_neutral_and_has_no_loosening_delay() {
    let key: SettingKey = "orgchange.apply_time".parse().unwrap();
    let now = time::OffsetDateTime::UNIX_EPOCH;
    let changed = check_change(
        key,
        &serde_json::json!(60),
        now,
        now,
        Some(SettingValue::Int(5)),
        false,
    )
    .unwrap();
    assert_eq!(changed.direction, Direction::Neutral);
}
