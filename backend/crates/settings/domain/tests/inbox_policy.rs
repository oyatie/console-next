// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_settings_domain::{
    Direction, Governance, LooserWhen, SettingKey, SettingValue, direction,
};

#[test]
fn inbox_decision_settings_default_to_existing_behavior_and_govern_loosening() {
    for class in [
        "org_structure",
        "people_correction",
        "identity_merge",
        "import_rollback",
    ] {
        for (property, looser_when) in
            [("bulk", LooserWhen::Higher), ("step_up", LooserWhen::Lower)]
        {
            let key: SettingKey = format!("approval.{property}.{class}").parse().unwrap();
            let def = key.def();
            assert_eq!(def.default, Some(SettingValue::Bool(false)));
            assert_eq!(def.governance, Governance::Tenant);
            assert_eq!(def.looser_when, looser_when);
            assert_eq!(
                direction(
                    key,
                    Some(SettingValue::Bool(false)),
                    SettingValue::Bool(true)
                ),
                if property == "bulk" {
                    Direction::Loosen
                } else {
                    Direction::Tighten
                }
            );
        }
    }
    assert!(
        "approval.merge_consecutive.org_structure"
            .parse::<SettingKey>()
            .is_err()
    );
}
