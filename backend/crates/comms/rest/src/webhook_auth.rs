// SPDX-License-Identifier: LicenseRef-Proprietary

use aws_lc_rs::constant_time::verify_slices_are_equal;
use aws_lc_rs::digest::{Context as DigestContext, SHA256};
use secrecy::{ExposeSecret, SecretString};

const MOX_WEBHOOK_AUTH_DOMAIN: &[u8] = b"console.comms.mox_webhook.bearer.v1\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MoxWebhookAuthError {
    Unconfigured,
    InvalidCredential,
}

/// Authenticate the incoming `Authorization: Bearer <secret>` header against
/// the configured webhook secret in constant time without allocating a
/// plaintext `"Bearer <secret>"` string or leaking secret length.
pub(crate) fn verify_mox_bearer_secret(
    configured: Option<&SecretString>,
    presented_authorization: Option<&str>,
) -> Result<(), MoxWebhookAuthError> {
    let Some(secret) = configured.filter(|s| !s.expose_secret().trim().is_empty()) else {
        return Err(MoxWebhookAuthError::Unconfigured);
    };

    let mut expected_ctx = DigestContext::new(&SHA256);
    expected_ctx.update(MOX_WEBHOOK_AUTH_DOMAIN);
    expected_ctx.update(b"Bearer ");
    expected_ctx.update(secret.expose_secret().as_bytes());
    let expected_digest = expected_ctx.finish();

    let mut presented_ctx = DigestContext::new(&SHA256);
    presented_ctx.update(MOX_WEBHOOK_AUTH_DOMAIN);
    presented_ctx.update(presented_authorization.unwrap_or_default().as_bytes());
    let presented_digest = presented_ctx.finish();

    verify_slices_are_equal(presented_digest.as_ref(), expected_digest.as_ref())
        .map_err(|_| MoxWebhookAuthError::InvalidCredential)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_eq_rejects_256_length_delta_and_shorter_or_longer() {
        let secret = SecretString::from("test-mox-webhook-secret".to_owned());
        let exact = "Bearer test-mox-webhook-secret";
        assert_eq!(verify_mox_bearer_secret(Some(&secret), Some(exact)), Ok(()));

        let mut delta_256 = exact.to_owned();
        delta_256.extend(std::iter::repeat_n('x', 256));
        assert_eq!(
            verify_mox_bearer_secret(Some(&secret), Some(&delta_256)),
            Err(MoxWebhookAuthError::InvalidCredential)
        );
        assert_eq!(
            verify_mox_bearer_secret(Some(&secret), Some(&exact[..exact.len() - 1])),
            Err(MoxWebhookAuthError::InvalidCredential)
        );
        assert_eq!(
            verify_mox_bearer_secret(Some(&secret), Some(&format!("{exact}x"))),
            Err(MoxWebhookAuthError::InvalidCredential)
        );
        assert_eq!(
            verify_mox_bearer_secret(Some(&secret), Some("Bearer test-mox-webhook-secreu")),
            Err(MoxWebhookAuthError::InvalidCredential)
        );
        assert_eq!(
            verify_mox_bearer_secret(Some(&secret), None),
            Err(MoxWebhookAuthError::InvalidCredential)
        );
    }

    #[test]
    fn empty_or_whitespace_configured_secret_is_unconfigured() {
        for blank in ["", "   ", "\t\n"] {
            let secret = SecretString::from(blank.to_owned());
            assert_eq!(
                verify_mox_bearer_secret(Some(&secret), Some("Bearer ")),
                Err(MoxWebhookAuthError::Unconfigured)
            );
        }
        assert_eq!(
            verify_mox_bearer_secret(None, Some("Bearer anything")),
            Err(MoxWebhookAuthError::Unconfigured)
        );
    }
}
