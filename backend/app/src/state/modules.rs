//! State that only compiled-in modules need (docs/ops/mvp-build.md): push
//! notifications for dispatch and the support desk, and the webmail cipher and
//! sync worker.

use crate::config::AppConfig;
#[cfg(feature = "mail")]
use crate::config::role::AppRole;
use crate::error::AppError;
#[cfg(feature = "mail")]
use crate::mail_sync;
use crate::state::AppState;
#[cfg(feature = "mail")]
use crate::state::DatabaseDependency;
#[cfg(feature = "mail")]
use console_comms_credential_cipher::EnvelopeCredentialCipher;
#[cfg(any(feature = "dispatch", feature = "support"))]
use console_platform_push::{FcmHttpV1Client, ProviderPushNotifier, SolapiAlimtalkClient};
use std::sync::Arc;

/// FCM / Solapi push for the dispatch timers and the support desk.
#[cfg(any(feature = "dispatch", feature = "support"))]
pub(super) fn attach_push_notifier(
    state: &mut AppState,
    config: &AppConfig,
) -> Result<(), AppError> {
    let fcm = config
        .fcm
        .clone()
        .map(FcmHttpV1Client::new)
        .transpose()
        .map_err(|err| AppError::Config(format!("invalid FCM config: {err}")))?;
    let solapi = config
        .solapi
        .clone()
        .map(SolapiAlimtalkClient::new)
        .transpose()
        .map_err(|err| AppError::Config(format!("invalid Solapi config: {err}")))?;
    if let Some(reason) = &config.solapi_disabled_reason {
        tracing::warn!(reason = %reason, "Solapi Alimtalk escalation disabled");
    }
    if fcm.is_some() || solapi.is_some() {
        state.push_notifier = Some(Arc::new(ProviderPushNotifier::new(fcm, solapi)));
    }
    Ok(())
}

#[cfg(feature = "mail")]
pub(super) fn attach_mail_cipher(state: &mut AppState) -> Result<(), AppError> {
    // Webmail master key (envelope AEAD KEK) — GRACEFULLY OPTIONAL. When
    // `CONSOLE_MAIL_MASTER_KEY` is present + valid it arms the webmail credential
    // cipher; when it is absent the app STILL boots and the mail router still
    // mounts (so the OpenAPI paths exist). Read-only mail endpoints degrade to
    // a clean no-account/empty state; credential-using endpoints return a clear
    // `503 email_not_configured`. If it is present but malformed, that's a
    // boot error so it is caught immediately rather than at first use.
    // H6c: the key may come from `CONSOLE_MAIL_MASTER_KEY_FILE`.
    let master_key =
        crate::config::secret_files::secret_env(console_comms_credential_cipher::MASTER_KEY_ENV)?;
    match master_key.map(EnvelopeCredentialCipher::from_owned_base64_key) {
        Some(Ok(cipher)) => state.mail_cipher = Some(Arc::new(cipher)),
        None => {
            tracing::info!(
                "CONSOLE_MAIL_MASTER_KEY unset: credential-using webmail endpoints are unavailable; read paths stay clean and the app boots normally"
            );
        }
        Some(Err(_)) => {
            return Err(AppError::Config(
                "CONSOLE_MAIL_MASTER_KEY is set but is not a valid base64 32-byte key".to_owned(),
            ));
        }
    }
    Ok(())
}

#[cfg(feature = "mail")]
pub(super) fn spawn_mail_sync(state: &mut AppState, config: &AppConfig) {
    // Inbound webmail sync worker (B-mail-3). Spawned like the realtime
    // listener: a background loop on the app pool that arms `app.current_org`
    // per tenant for each sync pass. GRACEFUL — only runs when the master KEK,
    // object storage, and `CONSOLE_MAIL_ENABLED` are all present; otherwise a
    // no-op so the app boots normally and mail endpoints still mount.
    //
    // WORKER-ROLE ONLY: this background ticker belongs on the worker, never on
    // the horizontally-scaled API pods — every API replica running its own
    // ticker would sync the same mailboxes concurrently. Even on the worker it
    // is HA-safe because the due-account claim leases each row with FOR UPDATE
    // SKIP LOCKED (migration 0116), so >1 worker replica still claim disjoint
    // batches.
    if let DatabaseDependency::Postgres(pool) = &state.database
        && config.role == AppRole::Worker
    {
        state.mail_sync_handle = mail_sync::spawn(
            pool.clone(),
            state.mail_cipher.clone(),
            state.sales_media_storage.clone(),
            config.mail_enabled,
        )
        .map(Arc::new);
    }
}
