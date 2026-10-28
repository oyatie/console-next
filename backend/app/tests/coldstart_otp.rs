// SPDX-License-Identifier: LicenseRef-Proprietary
//! INF-06 / B7: the published dev cold-start OTP never boots (split from config.rs).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_app::{AppConfig, AppRole};

#[path = "coldstart_otp/single_use.rs"]
mod single_use;

#[path = "coldstart_otp/admin_issued.rs"]
mod admin_issued;

fn app_pairs() -> Vec<(&'static str, String)> {
    vec![
        ("CONSOLE_APP_ROLE", AppRole::Api.to_string()),
        ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
    ]
}

#[test]
fn from_env_refuses_dev_coldstart_otp_with_cookie_secure_unset() {
    const CHILD: &str = "CONSOLE_CONFIG_GUARD_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        assert!(std::env::var_os("CONSOLE_COOKIE_SECURE").is_none());
        let message = AppConfig::from_env().unwrap_err().to_string();
        assert!(message.contains("CONSOLE_COLDSTART_OTP"), "{message}");
        assert!(message.contains("published dev value"), "{message}");
        return;
    }

    // A child process isolates the environment from the other parallel config tests.
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "from_env_refuses_dev_coldstart_otp_with_cookie_secure_unset",
            "--nocapture",
        ])
        .env_clear()
        .envs(app_pairs())
        .env(CHILD, "1")
        .env("CONSOLE_COLDSTART_OTP", "coss0000")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn dev_coldstart_otp_is_refused_on_plain_http_dev_too() {
    use p256::ecdsa::SigningKey;
    use p256::elliptic_curve::rand_core::OsRng;
    use p256::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};

    let key = SigningKey::random(&mut OsRng);
    let mut pairs = app_pairs();
    pairs.extend([
        ("CONSOLE_JWT_ISSUER", "console-dev".to_owned()),
        ("CONSOLE_JWT_AUDIENCE", "console".to_owned()),
        (
            "CONSOLE_JWT_PRIVATE_KEY_PEM",
            key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
        ),
        (
            "CONSOLE_JWT_PUBLIC_KEY_PEM",
            key.verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap(),
        ),
        ("CONSOLE_WEBAUTHN_RP_ID", "localhost".to_owned()),
        (
            "CONSOLE_WEBAUTHN_RP_ORIGIN",
            "http://localhost:5173".to_owned(),
        ),
        ("CONSOLE_COOKIE_SECURE", "false".to_owned()),
    ]);
    // A per-checkout code boots with insecure cookies (local HTTP development).
    let mut fresh = pairs.clone();
    fresh.push(("CONSOLE_COLDSTART_OTP", "K7Q2MZXR".to_owned()));
    assert!(AppConfig::from_pairs(fresh).is_ok());
    // The published literal never boots, whatever the cookie setting.
    pairs.push(("CONSOLE_COLDSTART_OTP", "coss0000".to_owned()));
    let message = AppConfig::from_pairs(pairs).unwrap_err().to_string();
    assert!(message.contains("CONSOLE_COLDSTART_OTP"), "{message}");
    assert!(message.contains("published dev value"), "{message}");
}
