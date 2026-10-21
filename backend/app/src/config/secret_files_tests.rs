use std::collections::HashMap;

use super::{resolve_file_vars, secret};
use crate::config::AppConfig;

fn file(name: &str, content: &str) -> String {
    let path = std::env::temp_dir().join(format!("h6c-{}-{name}", std::process::id()));
    std::fs::write(&path, content).unwrap();
    path.display().to_string()
}

#[test]
fn a_secret_file_supplies_the_variable() {
    let otp = file("otp", "123456\n");
    let pem = file("pem", "-----BEGIN-----\nAAA\n-----END-----\n");
    let config = AppConfig::from_pairs([
        ("CONSOLE_COLDSTART_OTP_FILE", otp.as_str()),
        ("CONSOLE_JWT_PUBLIC_KEY_PEM_FILE", pem.as_str()),
    ])
    .unwrap();
    assert_eq!(config.coldstart_otp.as_deref(), Some("123456"));
    assert_eq!(
        config.jwt.as_ref().unwrap().public_key_pem,
        "-----BEGIN-----\nAAA\n-----END-----",
        "only trailing newlines are trimmed"
    );
    for path in [otp, pem] {
        std::fs::remove_file(path).unwrap();
    }
}

#[test]
fn both_or_an_unreadable_file_is_a_config_error_that_never_shows_the_value() {
    let otp = file("both", "s3cret-value");
    let both = AppConfig::from_pairs([
        ("CONSOLE_COLDSTART_OTP", "s3cret-value"),
        ("CONSOLE_COLDSTART_OTP_FILE", otp.as_str()),
    ])
    .unwrap_err()
    .to_string();
    assert!(both.contains("CONSOLE_COLDSTART_OTP") && !both.contains("s3cret"));
    let missing = AppConfig::from_pairs([("DATABASE_URL_FILE", "/nonexistent/h6c")])
        .unwrap_err()
        .to_string();
    assert!(missing.contains("DATABASE_URL_FILE"), "{missing}");
    std::fs::remove_file(otp).unwrap();
}

#[test]
fn path_and_library_variables_are_left_alone() {
    let mut vars = HashMap::from([
        (
            "CONSOLE_DEV_LIFECYCLE_TODAY_FILE".to_owned(),
            "/nonexistent/today".to_owned(),
        ),
        ("SSL_CERT_FILE".to_owned(), "/nonexistent/ca.pem".to_owned()),
    ]);
    resolve_file_vars(&mut vars).unwrap();
    assert_eq!(vars.len(), 2);
}

#[test]
fn a_direct_reader_gets_the_file_too() {
    let key = file("mail", "a2V5\r\n");
    let env = HashMap::from([("CONSOLE_MAIL_MASTER_KEY_FILE".to_owned(), key)]);
    let got = secret("CONSOLE_MAIL_MASTER_KEY", |k| env.get(k).cloned()).unwrap();
    std::fs::remove_file(&env["CONSOLE_MAIL_MASTER_KEY_FILE"]).unwrap();
    assert_eq!(got.as_deref(), Some("a2V5"));
    assert_eq!(
        secret("CONSOLE_RRN_HMAC_KEY", |k| env.get(k).cloned()).unwrap(),
        None
    );
}
