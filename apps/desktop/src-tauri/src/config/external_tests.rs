// SPDX-License-Identifier: LicenseRef-Proprietary
use super::external;
use tauri::Url;

fn url(s: &str) -> Url {
    Url::parse(s).unwrap()
}

#[test]
fn accepts_off_origin_https() {
    assert!(external(&url("https://evil.test/")));
    assert!(external(&url(
        "https://external.example.com/path?a=1#section"
    )));
}

#[test]
fn refuses_http() {
    assert!(!external(&url("http://plain.test/")));
    assert!(!external(&url("http://evil.test/path")));
}

#[test]
fn refuses_mailto() {
    assert!(!external(&url("mailto:a@b.test")));
}

#[test]
fn refuses_file() {
    assert!(!external(&url("file:///C:/Windows")));
}

#[test]
fn refuses_javascript() {
    assert!(!external(&url("javascript:alert(1)")));
}

#[test]
fn refuses_data() {
    assert!(!external(&url("data:text/html,x")));
}

#[test]
fn refuses_username_and_password() {
    assert!(!external(&url("https://user:pw@evil.test/")));
}

#[test]
fn refuses_username_only() {
    assert!(!external(&url("https://user@evil.test/")));
}

#[test]
fn refuses_password_only() {
    assert!(!external(&url("https://:pw@evil.test/")));
}
