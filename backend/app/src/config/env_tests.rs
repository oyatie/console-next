// SPDX-License-Identifier: LicenseRef-Proprietary

use crate::config::AppConfig;

#[test]
fn from_pairs_applies_dev_audit_chain_signer_guard_for_active_build_profile() {
    for seal_enabled in ["false", "true"] {
        let result = AppConfig::from_pairs([
            ("CONSOLE_AUDIT_CHAIN_ALLOW_DEV_SIGNER", "true"),
            ("CONSOLE_AUDIT_CHAIN_SEAL_ENABLED", seal_enabled),
        ]);
        if cfg!(debug_assertions) {
            assert!(result.unwrap().audit_chain_allow_dev_signer);
        } else {
            let error = result.expect_err("release builds must reject the development signer");
            assert!(
                error
                    .to_string()
                    .contains("CONSOLE_AUDIT_CHAIN_ALLOW_DEV_SIGNER"),
                "unexpected config error: {error}"
            );
        }
    }
}

#[test]
fn from_pairs_rejects_malformed_otp_hmac_key_in_all_profiles() {
    for role in ["api", "worker"] {
        for bad in ["not-hex-or-b64", "00".repeat(32).as_str(), "abcd"] {
            let err =
                AppConfig::from_pairs([("CONSOLE_APP_ROLE", role), ("CONSOLE_OTP_HMAC_KEY", bad)])
                    .expect_err("malformed CONSOLE_OTP_HMAC_KEY must fail");
            assert!(err.to_string().contains("CONSOLE_OTP_HMAC_KEY"), "{err}");
            assert!(!err.to_string().contains(bad), "error must not echo key");
        }
        let err = AppConfig::from_pairs([
            ("CONSOLE_APP_ROLE", role),
            ("CONSOLE_OTP_HMAC_KEY_PREV", &"11".repeat(32)),
        ])
        .expect_err("prev without active key must fail");
        assert!(err.to_string().contains("CONSOLE_OTP_HMAC_KEY"), "{err}");
    }
}

#[test]
fn from_pairs_allows_worker_with_postgres_and_without_otp_hmac_key() {
    let config = AppConfig::from_pairs([
        ("CONSOLE_APP_ROLE", "worker"),
        (
            "DATABASE_URL",
            "postgresql://console_rt:runtime-secret@db/console",
        ),
        (
            "PLATFORM_FORCE_COMMAND_DATABASE_URL",
            "postgresql://console_platform_force_cmd:force-secret@db/console",
        ),
    ])
    .expect("worker role does not require CONSOLE_OTP_HMAC_KEY");
    assert!(config.otp_hmac_key.is_none());
}

#[test]
fn from_pairs_applies_dev_auth_guard_for_active_build_profile() {
    let result = AppConfig::from_pairs([("CONSOLE_DEV_AUTH", "true")]);

    if cfg!(debug_assertions) {
        assert!(result.is_ok(), "debug builds allow the dev-auth marker");
    } else {
        let error = result.expect_err("release builds must reject the dev-auth marker");
        assert!(
            error
                .to_string()
                .contains("dev authentication is not allowed in a non-development build"),
            "unexpected config error: {error}"
        );
    }
}
