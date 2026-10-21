//! Outbound email (SMTP or the non-production stub) configuration.

use crate::config::EMAIL_STUB_MODE_ENV;
use crate::config::parse::non_empty;
use crate::error::AppError;
use console_platform_email::{SmtpEmailConfig, StubEmailMode};
use std::collections::HashMap;

/// Parse the single explicit policy that allows OTP-logging stub email.
///
/// The var is deliberately not boolean: operators must spell out a non-production
/// intent (`local`, `dev`, `development`, `test`, or `e2e`) and `production`/`true` are
/// rejected rather than accidentally enabling OTP logs.
pub(crate) fn email_stub_mode_from_vars(
    vars: &HashMap<String, String>,
) -> Result<Option<StubEmailMode>, AppError> {
    match non_empty(vars.get(EMAIL_STUB_MODE_ENV)) {
        Some(raw) => raw
            .parse::<StubEmailMode>()
            .map(Some)
            .map_err(|err| AppError::Config(format!("invalid {EMAIL_STUB_MODE_ENV}: {err}"))),
        None => Ok(None),
    }
}

/// Parse the outbound SMTP email relay config from the environment.
///
/// `Ok(None)` means there is no live SMTP config. The composition root may use a
/// `StubEmailSender` only when `stub_mode` is `Some`; otherwise the email sender
/// fails closed without logging OTPs. Any partial `CONSOLE_EMAIL_*` group is accepted
/// only in explicit stub mode, because production ConfigMap+missing-Secret paths
/// must not reach the OTP-logging stub.
pub(crate) fn email_config_from_vars(
    vars: &HashMap<String, String>,
    stub_mode: Option<StubEmailMode>,
) -> Result<Option<SmtpEmailConfig>, AppError> {
    let host = non_empty(vars.get("CONSOLE_EMAIL_SMTP_HOST"));
    let port_raw = non_empty(vars.get("CONSOLE_EMAIL_SMTP_PORT"));
    let username = non_empty(vars.get("CONSOLE_EMAIL_SMTP_USERNAME"));
    let password = non_empty(vars.get("CONSOLE_EMAIL_SMTP_PASSWORD"));
    let from_address = non_empty(vars.get("CONSOLE_EMAIL_FROM"));
    let from_name = non_empty(vars.get("CONSOLE_EMAIL_FROM_NAME"));
    let configured = host.is_some()
        || port_raw.is_some()
        || username.is_some()
        || password.is_some()
        || from_address.is_some()
        || from_name.is_some();
    if !configured {
        return Ok(None);
    }
    let missing_fields = [
        ("CONSOLE_EMAIL_SMTP_HOST", host.is_none()),
        ("CONSOLE_EMAIL_SMTP_PORT", port_raw.is_none()),
        ("CONSOLE_EMAIL_SMTP_USERNAME", username.is_none()),
        ("CONSOLE_EMAIL_SMTP_PASSWORD", password.is_none()),
        ("CONSOLE_EMAIL_FROM", from_address.is_none()),
        ("CONSOLE_EMAIL_FROM_NAME", from_name.is_none()),
    ]
    .into_iter()
    .filter_map(|(name, missing)| missing.then_some(name))
    .collect::<Vec<_>>();
    if !missing_fields.is_empty() {
        if let Some(mode) = stub_mode {
            tracing::warn!(
                email_stub_mode = %mode,
                missing = %missing_fields.join(", "),
                "CONSOLE_EMAIL_* partially configured; explicit non-production stub mode enabled, so OTP email uses the logging stub"
            );
            return Ok(None);
        }
        return Err(AppError::Config(format!(
            "CONSOLE_EMAIL_* is partially configured: missing {}; complete all SMTP fields for production startup or set {EMAIL_STUB_MODE_ENV}=local|dev|development|test|e2e only for explicit non-production stub OTP logging",
            missing_fields.join(", ")
        )));
    }
    let required = |value: Option<String>, name: &'static str| {
        value
            .ok_or_else(|| AppError::Config(format!("{name} is required when email is configured")))
    };
    let port = match port_raw {
        Some(raw) => raw
            .parse::<u16>()
            .map_err(|err| AppError::Config(format!("invalid CONSOLE_EMAIL_SMTP_PORT: {err}")))?,
        None => {
            return Err(AppError::Config(
                "CONSOLE_EMAIL_SMTP_PORT is required when email is configured".to_owned(),
            ));
        }
    };
    let config = SmtpEmailConfig {
        host: required(host, "CONSOLE_EMAIL_SMTP_HOST")?,
        port,
        username: required(username, "CONSOLE_EMAIL_SMTP_USERNAME")?,
        password: required(password, "CONSOLE_EMAIL_SMTP_PASSWORD")?,
        from_address: required(from_address, "CONSOLE_EMAIL_FROM")?,
        from_name: required(from_name, "CONSOLE_EMAIL_FROM_NAME")?,
    };
    config
        .validate()
        .map_err(|err| AppError::Config(err.to_string()))?;
    Ok(Some(config))
}

#[cfg(test)]
#[cfg(not(feature = "test-postgres"))]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod email_config_tests {
    //! Guards `email_config_from_vars` robustness. The regression being
    //! prevented: a partially-set `CONSOLE_EMAIL_*` group (ConfigMap supplies
    //! host/port/from, but the Secret with the SMTP creds is not yet
    //! provisioned) must not silently degrade to the OTP-logging stub in
    //! production. Stub OTP logging is allowed only behind an explicit
    //! development/e2e/test policy.

    use std::collections::HashMap;

    use console_platform_email::StubEmailMode;

    use super::{email_config_from_vars, email_stub_mode_from_vars};
    use crate::config::AppConfig;
    use crate::config::EMAIL_STUB_MODE_ENV;
    use crate::state::AppState;
    use crate::state::DatabaseDependency;

    /// The full, well-formed `CONSOLE_EMAIL_*` set that yields a live SMTP config.
    fn full_email_vars() -> HashMap<String, String> {
        [
            ("CONSOLE_EMAIL_SMTP_HOST", "smtp.example.com"),
            ("CONSOLE_EMAIL_SMTP_PORT", "587"),
            ("CONSOLE_EMAIL_SMTP_USERNAME", "ocid1.user.oc1..example"),
            ("CONSOLE_EMAIL_SMTP_PASSWORD", "secret"),
            ("CONSOLE_EMAIL_FROM", "noreply@example.com"),
            ("CONSOLE_EMAIL_FROM_NAME", "Console"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
    }

    fn app_pairs() -> Vec<(&'static str, String)> {
        vec![
            ("CONSOLE_APP_ROLE", "api".to_owned()),
            ("CONSOLE_HTTP_ADDR", "127.0.0.1:0".to_owned()),
        ]
    }

    #[test]
    fn unset_group_yields_no_config() {
        let vars = HashMap::new();
        assert!(email_config_from_vars(&vars, None).unwrap().is_none());
    }

    #[test]
    fn fully_set_group_yields_live_config() {
        let config = email_config_from_vars(&full_email_vars(), None)
            .unwrap()
            .expect("fully-configured email group should yield Some(config)");
        assert_eq!(config.host, "smtp.example.com");
        assert_eq!(config.port, 587);
        assert_eq!(config.username, "ocid1.user.oc1..example");
        assert_eq!(config.from_address, "noreply@example.com");
    }

    #[test]
    fn partial_config_missing_username_without_stub_mode_errors() {
        // ConfigMap set host/port/from, but the Secret (username) is absent.
        // In production this must fail closed instead of reaching the OTP-logging stub.
        let mut vars = full_email_vars();
        vars.remove("CONSOLE_EMAIL_SMTP_USERNAME");
        assert!(
            email_config_from_vars(&vars, None).is_err(),
            "missing SMTP username must fail closed unless explicit stub mode is enabled"
        );
    }

    #[test]
    fn partial_config_missing_username_with_stub_mode_falls_back_to_stub() {
        let mut vars = full_email_vars();
        vars.remove("CONSOLE_EMAIL_SMTP_USERNAME");
        assert!(
            email_config_from_vars(&vars, Some(StubEmailMode::E2e))
                .unwrap()
                .is_none(),
            "explicit e2e stub mode may fall back to the logging stub"
        );
    }

    #[test]
    fn partial_config_missing_password_without_stub_mode_errors() {
        let mut vars = full_email_vars();
        vars.remove("CONSOLE_EMAIL_SMTP_PASSWORD");
        assert!(
            email_config_from_vars(&vars, None).is_err(),
            "missing SMTP password must fail closed unless explicit stub mode is enabled"
        );
    }

    #[test]
    fn empty_credentials_without_stub_mode_error() {
        // Empty (not absent) creds — e.g. a Secret mounted with blank values —
        // are treated the same as missing and must fail closed outside stub mode.
        let mut vars = full_email_vars();
        vars.insert("CONSOLE_EMAIL_SMTP_USERNAME".to_owned(), "   ".to_owned());
        vars.insert("CONSOLE_EMAIL_SMTP_PASSWORD".to_owned(), String::new());
        assert!(email_config_from_vars(&vars, None).is_err());
    }

    #[test]
    fn email_stub_mode_env_accepts_only_explicit_non_production_modes() {
        let vars: HashMap<String, String> = [(EMAIL_STUB_MODE_ENV, "e2e")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        assert_eq!(
            email_stub_mode_from_vars(&vars).unwrap(),
            Some(StubEmailMode::E2e)
        );

        let vars: HashMap<String, String> = [(EMAIL_STUB_MODE_ENV, "production")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        assert!(email_stub_mode_from_vars(&vars).is_err());
    }

    #[tokio::test]
    async fn app_state_without_smtp_or_stub_mode_fails_closed_without_logging_otp() {
        let config = AppConfig::from_pairs(app_pairs()).unwrap();
        let state = AppState::new(config, DatabaseDependency::NotConfigured).unwrap();

        let result = state
            .email_sender()
            .send_otp(
                "ops@example.com",
                "123456",
                std::time::Duration::from_secs(300),
            )
            .await;

        assert!(
            result.is_err_and(|err| err.to_string().contains("disabled")),
            "without explicit stub mode, missing SMTP must fail closed instead of logging the OTP"
        );
    }

    #[tokio::test]
    async fn app_state_with_explicit_stub_mode_allows_nonprod_otp_logging_stub() {
        let mut pairs = app_pairs();
        pairs.push((EMAIL_STUB_MODE_ENV, "e2e".to_owned()));
        let config = AppConfig::from_pairs(pairs).unwrap();
        let state = AppState::new(config, DatabaseDependency::NotConfigured).unwrap();

        let result = state
            .email_sender()
            .send_otp(
                "ops@example.com",
                "123456",
                std::time::Duration::from_secs(300),
            )
            .await;

        assert!(result.is_ok());
    }

    /// Exhaustively prove the OTP-log leak footgun is closed: ANY permutation of
    /// the `CONSOLE_EMAIL_*` group that is set WITHOUT both SMTP credentials must
    /// error outside explicit stub mode. This is the prod scenario — a ConfigMap
    /// supplies some non-secret fields while the credential Secret is not yet
    /// provisioned — across every subset of the non-secret fields.
    #[test]
    fn every_partial_config_without_credentials_errors_without_stub_mode() {
        const NON_SECRET_KEYS: [(&str, &str); 4] = [
            ("CONSOLE_EMAIL_SMTP_HOST", "smtp.example.com"),
            ("CONSOLE_EMAIL_SMTP_PORT", "587"),
            ("CONSOLE_EMAIL_FROM", "noreply@example.com"),
            ("CONSOLE_EMAIL_FROM_NAME", "Console"),
        ];
        // All 16 subsets of the 4 non-secret fields, crossed with the 3 broken
        // credential states (no username, no password, neither). The empty subset
        // with no creds is the all-unset case and remains Ok(None); every other
        // configured subset must fail closed.
        for mask in 0u8..(1 << NON_SECRET_KEYS.len()) {
            for creds in [
                &[("CONSOLE_EMAIL_SMTP_USERNAME", "ocid1.user.oc1..example")][..],
                &[("CONSOLE_EMAIL_SMTP_PASSWORD", "secret")][..],
                &[][..],
            ] {
                let mut vars: HashMap<String, String> = HashMap::new();
                for (bit, (key, value)) in NON_SECRET_KEYS.iter().enumerate() {
                    if mask & (1 << bit) != 0 {
                        vars.insert((*key).to_owned(), (*value).to_owned());
                    }
                }
                for (key, value) in creds {
                    vars.insert((*key).to_owned(), (*value).to_owned());
                }
                if vars.is_empty() {
                    assert!(email_config_from_vars(&vars, None).unwrap().is_none());
                    continue;
                }
                assert!(
                    email_config_from_vars(&vars, None).is_err(),
                    "partial config (mask={mask:#06b}, creds={creds:?}) must fail \
                     closed unless explicit stub mode is enabled"
                );
            }
        }
    }

    #[test]
    fn creds_present_but_missing_host_still_errors() {
        // With BOTH secrets in hand, a missing non-secret field is a genuine
        // operator misconfiguration and still hard-errors (not the missing-Secret
        // crashloop this guard targets).
        let mut vars = full_email_vars();
        vars.remove("CONSOLE_EMAIL_SMTP_HOST");
        assert!(email_config_from_vars(&vars, None).is_err());
    }

    #[test]
    fn creds_present_but_missing_port_still_errors() {
        let mut vars = full_email_vars();
        vars.remove("CONSOLE_EMAIL_SMTP_PORT");
        assert!(email_config_from_vars(&vars, None).is_err());
    }

    #[test]
    fn creds_present_but_missing_from_still_errors() {
        let mut vars = full_email_vars();
        vars.remove("CONSOLE_EMAIL_FROM");
        assert!(email_config_from_vars(&vars, None).is_err());
    }

    #[test]
    fn creds_present_but_invalid_port_still_errors() {
        // A non-numeric port is an operator typo, not a missing Secret — error.
        let mut vars = full_email_vars();
        vars.insert(
            "CONSOLE_EMAIL_SMTP_PORT".to_owned(),
            "not-a-port".to_owned(),
        );
        assert!(email_config_from_vars(&vars, None).is_err());
    }

    #[test]
    fn credentials_only_without_relay_fields_errors() {
        // Only the secrets are set (no host/port/from). The operator must supply
        // the relay fields once creds exist; silently sending nowhere or using the
        // stub would hide a broken production delivery path.
        let vars: HashMap<String, String> = [
            ("CONSOLE_EMAIL_SMTP_USERNAME", "ocid1.user.oc1..example"),
            ("CONSOLE_EMAIL_SMTP_PASSWORD", "secret"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        assert!(email_config_from_vars(&vars, None).is_err());
    }
}
