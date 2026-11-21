// SPDX-License-Identifier: LicenseRef-Proprietary

use crate::coldstart_guard::{BuildProfile, require_otp_hmac_key};
use crate::config::AppConfig;
use crate::config::role::AppRole;
use crate::error::AppError;
use crate::state::DatabaseDependency;
use console_platform_auth_rest::AuthRestState;
use console_platform_provisioning::{BootstrapCredentialStore, OtpHmacKey};

pub(crate) fn resolve_otp_hmac_key(
    config: &AppConfig,
    database: &DatabaseDependency,
) -> Result<Option<OtpHmacKey>, AppError> {
    resolve_otp_hmac_key_for_profile(config, database, BuildProfile::current())
}

pub(crate) fn resolve_otp_hmac_key_for_profile(
    config: &AppConfig,
    database: &DatabaseDependency,
    build_profile: BuildProfile,
) -> Result<Option<OtpHmacKey>, AppError> {
    if let Some(key) = config.otp_hmac_key.clone() {
        return Ok(Some(key));
    }
    match build_profile {
        BuildProfile::Development => {
            let _ = database;
            if config.role == AppRole::Api {
                #[cfg(debug_assertions)]
                {
                    Ok(Some(OtpHmacKey::try_dev_process_key().map_err(|err| {
                        AppError::Config(format!("failed to initialize dev OTP HMAC key: {err}"))
                    })?))
                }
                #[cfg(not(debug_assertions))]
                {
                    Err(AppError::Config(
                        "development OTP HMAC key is unavailable in non-development builds"
                            .to_owned(),
                    ))
                }
            } else {
                Ok(None)
            }
        }
        BuildProfile::NonDevelopment => {
            let api_needs_otp_key = matches!(database, DatabaseDependency::Postgres(_))
                || config.auth_rest.is_some()
                || config.coldstart_otp.is_some();
            require_otp_hmac_key(
                false,
                config.role == AppRole::Api,
                api_needs_otp_key,
                build_profile,
            )
            .map_err(AppError::Config)?;
            Ok(None)
        }
    }
}

pub(crate) fn build_auth_rest_state(
    config: &AppConfig,
    database: &DatabaseDependency,
    otp_hmac_key: Option<&OtpHmacKey>,
) -> Result<Option<AuthRestState>, AppError> {
    match database {
        DatabaseDependency::Postgres(pool) => match &config.auth_rest {
            Some(auth_config) => {
                let mut state = AuthRestState::new(pool.clone(), auth_config.clone())
                    .map_err(|err| AppError::Config(format!("invalid auth REST config: {err}")))?;
                if let Some(key) = otp_hmac_key {
                    state = state
                        .with_bootstrap_credentials(BootstrapCredentialStore::new(key.clone()));
                }
                Ok(Some(state))
            }
            None => Ok(Some(AuthRestState::disabled(pool.clone()))),
        },
        DatabaseDependency::NotConfigured => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_otp_hmac_key_for_profile;
    use crate::coldstart_guard::BuildProfile;
    use crate::config::AppConfig;
    use crate::error::AppError;
    use crate::state::{AppState, DatabaseDependency};
    use console_platform_auth_rest::AuthRestConfig;
    use console_platform_provisioning::OtpHmacKey;
    use sqlx::PgPool;
    use time::Duration;

    fn base_config(role: &str) -> AppConfig {
        AppConfig::from_pairs([("CONSOLE_APP_ROLE", role)]).unwrap()
    }

    fn lazy_postgres() -> DatabaseDependency {
        let pool = PgPool::connect_lazy("postgres://console_rt:secret@127.0.0.1:1/unused").unwrap();
        DatabaseDependency::Postgres(pool)
    }

    fn dummy_auth_rest() -> AuthRestConfig {
        AuthRestConfig {
            rp_id: "localhost".to_owned(),
            rp_origin: "https://localhost".to_owned(),
            rp_name: "Console".to_owned(),
            ceremony_ttl: Duration::minutes(5),
            jwt_issuer: "console".to_owned(),
            jwt_audience: "console".to_owned(),
            access_token_ttl: Duration::minutes(15),
            jwt_private_key_pem: String::new(),
            jwt_public_key_pem: String::new(),
            refresh_token_ttl: Duration::days(7),
            refresh_family_absolute_ttl: Duration::days(30),
            cookie_secure: true,
        }
    }

    #[tokio::test]
    async fn non_development_worker_without_key_returns_none_even_with_postgres() {
        let config = base_config("worker");
        let resolved = resolve_otp_hmac_key_for_profile(
            &config,
            &lazy_postgres(),
            BuildProfile::NonDevelopment,
        )
        .expect("worker role without CONSOLE_OTP_HMAC_KEY must succeed in non-dev");
        assert!(resolved.is_none());

        let state = AppState::new(config, lazy_postgres())
            .expect("worker AppState::new must succeed with Postgres and no OTP HMAC key");
        assert!(state.otp_hmac_key.is_none());
    }

    #[tokio::test]
    async fn non_development_api_without_key_fails_closed_for_db_auth_or_coldstart() {
        let pg_err = resolve_otp_hmac_key_for_profile(
            &base_config("api"),
            &lazy_postgres(),
            BuildProfile::NonDevelopment,
        )
        .expect_err("api with Postgres must fail closed without key");
        assert!(matches!(pg_err, AppError::Config(_)));
        assert!(pg_err.to_string().contains("CONSOLE_OTP_HMAC_KEY"));

        let mut with_auth = base_config("api");
        with_auth.auth_rest = Some(dummy_auth_rest());
        let auth_err = resolve_otp_hmac_key_for_profile(
            &with_auth,
            &DatabaseDependency::NotConfigured,
            BuildProfile::NonDevelopment,
        )
        .expect_err("api with auth_rest must fail closed without key");
        assert!(matches!(auth_err, AppError::Config(_)));
        assert!(auth_err.to_string().contains("CONSOLE_OTP_HMAC_KEY"));

        let mut with_coldstart = base_config("api");
        with_coldstart.coldstart_otp = Some("fresh-secret".to_owned());
        let coldstart_err = resolve_otp_hmac_key_for_profile(
            &with_coldstart,
            &DatabaseDependency::NotConfigured,
            BuildProfile::NonDevelopment,
        )
        .expect_err("api with coldstart_otp must fail closed without key");
        assert!(matches!(coldstart_err, AppError::Config(_)));
        assert!(coldstart_err.to_string().contains("CONSOLE_OTP_HMAC_KEY"));

        let stateless = resolve_otp_hmac_key_for_profile(
            &base_config("api"),
            &DatabaseDependency::NotConfigured,
            BuildProfile::NonDevelopment,
        )
        .expect("stateless api without db/auth/coldstart returns None");
        assert!(stateless.is_none());
    }

    #[tokio::test]
    async fn non_development_returns_explicit_key_for_api_and_worker() {
        let key = OtpHmacKey::from_bytes([0x42; 32], None).unwrap();
        for role in ["api", "worker"] {
            let mut config = base_config(role);
            config.otp_hmac_key = Some(key.clone());
            let resolved = resolve_otp_hmac_key_for_profile(
                &config,
                &lazy_postgres(),
                BuildProfile::NonDevelopment,
            )
            .expect("explicit key must succeed");
            assert_eq!(resolved, Some(key.clone()));
        }
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn development_profile_uses_ephemeral_key_for_api_and_none_for_worker() {
        let api_key = resolve_otp_hmac_key_for_profile(
            &base_config("api"),
            &lazy_postgres(),
            BuildProfile::Development,
        )
        .expect("dev api must resolve ephemeral OTP HMAC key")
        .expect("dev api must return Some(key)");
        let api_key_again =
            super::resolve_otp_hmac_key(&base_config("api"), &DatabaseDependency::NotConfigured)
                .expect("resolve_otp_hmac_key must succeed in debug")
                .expect("dev api must return process-wide key");
        assert_eq!(api_key, api_key_again);

        let worker_key = resolve_otp_hmac_key_for_profile(
            &base_config("worker"),
            &lazy_postgres(),
            BuildProfile::Development,
        )
        .expect("dev worker without key must succeed");
        assert!(worker_key.is_none());
    }
}
