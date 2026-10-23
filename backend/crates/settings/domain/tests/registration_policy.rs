// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Registration deletion shares the existing calendar and owns a distinct reason catalog.
use console_settings_domain::SettingKey;
use console_settings_domain::code_lists::ReasonDomain;

#[test]
fn no_registration_only_calendar_setting_is_exposed() {
    assert!("calendar.time_zone".parse::<SettingKey>().is_err());
}

#[test]
fn business_registration_end_reasons_are_registered_and_need_no_note() {
    let domain: ReasonDomain = "business_registration_end".parse().unwrap();
    assert!("registration_void".parse::<ReasonDomain>().is_err());
    let codes: Vec<_> = domain
        .system_codes()
        .iter()
        .filter(|c| !c.requires_note)
        .map(|c| c.code)
        .collect();
    assert_eq!(codes, ["DUPLICATE", "TEST_ENTRY", "WRONG_DOCUMENT"]);
}
