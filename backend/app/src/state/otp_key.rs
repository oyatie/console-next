// SPDX-License-Identifier: LicenseRef-Proprietary

use crate::config::AppConfig;
use crate::error::AppError;
use crate::state::DatabaseDependency;
use console_platform_auth_rest::AuthRestState;
use console_platform_email::EmailSender;
use console_platform_provisioning::{BootstrapCredentialStore, OtpHmacKey};
use std::sync::Arc;

pub(crate) fn resolve_otp_hmac_key(
    config: &AppConfig,
    database: &DatabaseDependency,
) -> Result<Option<OtpHmacKey>, AppError> {
    match config.otp_hmac_key.clone() {
        Some(key) => Ok(Some(key)),
        None => {
            #[cfg(debug_assertions)]
            {
                let _ = database;
                Ok(Some(OtpHmacKey::try_dev_process_key().map_err(|err| {
                    AppError::Config(format!("failed to initialize dev OTP HMAC key: {err}"))
                })?))
            }
            #[cfg(not(debug_assertions))]
            {
                if matches!(database, DatabaseDependency::Postgres(_))
                    || config.auth_rest.is_some()
                    || config.coldstart_otp.is_some()
                {
                    return Err(AppError::Config(
                        "CONSOLE_OTP_HMAC_KEY is required in non-development builds".to_owned(),
                    ));
                }
                Ok(None)
            }
        }
    }
}

pub(crate) fn build_auth_rest_state(
    config: &AppConfig,
    database: &DatabaseDependency,
    email_sender: &Arc<dyn EmailSender>,
    otp_hmac_key: Option<&OtpHmacKey>,
) -> Result<Option<AuthRestState>, AppError> {
    match database {
        DatabaseDependency::Postgres(pool) => match &config.auth_rest {
            Some(auth_config) => {
                let mut state = AuthRestState::new(pool.clone(), auth_config.clone())
                    .map_err(|err| AppError::Config(format!("invalid auth REST config: {err}")))?
                    .with_email_sender(email_sender.clone());
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
