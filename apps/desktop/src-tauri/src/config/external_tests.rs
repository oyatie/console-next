// SPDX-License-Identifier: LicenseRef-Proprietary
use super::external;
use tauri::Url;

fn url(s: &str) -> Url {
    Url::parse(s).unwrap()
}

#[test]
fn external_accepts_off_origin_https_and_refuses_insecure_schemes_and_userinfo() {
    // Accepts https off-origin without userinfo
    assert!(external(&url("https://evil.test/")));
    assert!(external(&url(
        "https://external.example.com/path?a=1#section"
    )));

    // Refuses insecure schemes
    assert!(
        !external(&url("http://plain.test/")),
        "http must be refused"
    );
    assert!(
        !external(&url("http://evil.test/path")),
        "http with path must be refused"
    );
    assert!(!external(&url("mailto:a@b.test")), "mailto must be refused");
    assert!(
        !external(&url("file:///C:/Windows")),
        "file must be refused"
    );
    assert!(
        !external(&url("javascript:alert(1)")),
        "javascript must be refused"
    );
    assert!(!external(&url("data:text/html,x")), "data must be refused");

    // Refuses https with userinfo (credentials)
    assert!(
        !external(&url("https://user:pw@evil.test/")),
        "https with user and password must be refused"
    );
    assert!(
        !external(&url("https://user@evil.test/")),
        "https with user only must be refused"
    );
    assert!(
        !external(&url("https://:pw@evil.test/")),
        "https with password only must be refused"
    );
}
