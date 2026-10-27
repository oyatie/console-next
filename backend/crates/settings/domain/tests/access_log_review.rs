// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_settings_domain::{Governance, LooserWhen, SettingKey, SettingValue};

#[test]
fn review_settings_follow_plan_section_eight_without_inventing_owner_thresholds() {
    for (suffix, value, direction) in [
        ("cadence_months", SettingValue::Int(1), LooserWhen::Higher),
        (
            "due_business_days",
            SettingValue::Int(1),
            LooserWhen::Higher,
        ),
        (
            "reason_due_business_days",
            SettingValue::Int(5),
            LooserWhen::Higher,
        ),
        (
            "time_zone",
            SettingValue::Code("Asia/Seoul"),
            LooserWhen::Neutral,
        ),
        (
            "off_hours.start_hour",
            SettingValue::Int(20),
            LooserWhen::Higher,
        ),
        (
            "off_hours.end_hour",
            SettingValue::Int(8),
            LooserWhen::Lower,
        ),
        (
            "flag.off_hours_min",
            SettingValue::Int(1),
            LooserWhen::Higher,
        ),
        (
            "flag.downloads_per_day_min",
            SettingValue::Int(3),
            LooserWhen::Higher,
        ),
        (
            "flag.every_download",
            SettingValue::Bool(true),
            LooserWhen::Lower,
        ),
    ] {
        let key: SettingKey = format!("access_log_review.{suffix}").parse().unwrap();
        assert_eq!(key.def().default, Some(value));
        assert_eq!(key.def().governance, Governance::Tenant);
        assert_eq!(key.def().looser_when, direction);
    }
    for suffix in ["bulk_subjects_min", "denied_min"] {
        let key: SettingKey = format!("access_log_review.flag.{suffix}").parse().unwrap();
        assert!(key.def().is_fact(), "owner has not set this threshold");
        assert!(!key.def().in_range(SettingValue::Int(0)));
    }
    let zone: SettingKey = "access_log_review.time_zone".parse().unwrap();
    assert!(zone.def().parse(&serde_json::json!("UTC")).is_none());
}

#[test]
fn review_policy_rejects_values_outside_each_registered_range() {
    for (suffix, min, max) in [
        ("cadence_months", 1, Some(3)),
        ("due_business_days", 1, Some(10)),
        ("reason_due_business_days", 1, Some(10)),
        ("off_hours.start_hour", 0, Some(23)),
        ("off_hours.end_hour", 0, Some(23)),
        ("flag.off_hours_min", 1, None),
        ("flag.bulk_subjects_min", 1, None),
        ("flag.denied_min", 1, None),
        ("flag.downloads_per_day_min", 1, None),
    ] {
        let key: SettingKey = format!("access_log_review.{suffix}").parse().unwrap();
        assert!(key.def().in_range(SettingValue::Int(min)));
        assert!(!key.def().in_range(SettingValue::Int(min - 1)));
        if let Some(max) = max {
            assert!(key.def().in_range(SettingValue::Int(max)));
            assert!(!key.def().in_range(SettingValue::Int(max + 1)));
        }
    }
}
