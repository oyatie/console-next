// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
//! Registration deletion uses the registered calendar and reason catalog.
use console_settings_domain::code_lists::ReasonDomain;
use console_settings_domain::{SettingKey, resolve};
use serde_json::json;

#[test]
fn calendar_time_zone_uses_the_iana_catalog_and_rejects_unknown_zones() {
    let key: SettingKey = "calendar.time_zone".parse().unwrap();
    for zone in [
        "Asia/Seoul",
        "Pacific/Honolulu",
        "Pacific/Kiritimati",
        "Europe/Paris",
        "UTC",
    ] {
        assert!(key.def().parse(&json!(zone)).is_some());
    }
    assert!(key.def().parse(&json!("Mars/Olympus")).is_none());
    assert!(key.def().parse(&json!(9)).is_none());
    assert!(resolve(key, &[], None, time::OffsetDateTime::now_utc()).is_ok());
}

#[test]
fn registration_void_reasons_are_registered_and_need_no_note() {
    let domain: ReasonDomain = "registration_void".parse().unwrap();
    let codes: Vec<_> = domain
        .system_codes()
        .iter()
        .filter(|c| !c.requires_note)
        .map(|c| c.code)
        .collect();
    assert_eq!(codes, ["DUPLICATE", "TEST_ENTRY", "WRONG_DOCUMENT"]);
}
