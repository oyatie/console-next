// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_settings_domain::{SettingKey, SettingKind, SettingValue, Unit};
use time::macros::date;

#[test]
fn objection_review_has_operational_bounds_and_an_explicit_nonstatutory_citation() {
    let key: SettingKey = "privacy.rights.objection_review_days".parse().unwrap();
    let def = key.def();
    assert_eq!(
        def.kind,
        SettingKind::Int {
            unit: Unit::Days,
            min: Some(1),
            max: Some(30)
        }
    );
    assert_eq!(def.default, Some(SettingValue::Int(10)));
    let citation = def.legal_basis.unwrap();
    assert!(citation.title.contains("법정 기한 없음 · 운영 기준"));
    assert_eq!(citation.retrieved_on, date!(2026 - 10 - 27));
}
