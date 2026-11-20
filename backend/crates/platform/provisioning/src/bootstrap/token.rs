use super::BootstrapToken;
use crate::ProvisioningError;
use aws_lc_rs::digest::{Context as DigestContext, SHA256, digest};
use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use secrecy::SecretString;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
use zeroize::Zeroize;

#[path = "format.rs"]
mod format;
pub use format::*;

pub(crate) const PLATFORM_INVITE_TOKEN_PREFIX: &str = "cop_";
const PLATFORM_INVITE_HASH_DOMAIN: &[u8] = b"console.platform_operator_invite.v1\0";
const PLATFORM_INVITE_RANDOM_BYTES: usize = 32;

/// Resolve a bootstrap credential's tenant from its token hash, via the narrow
/// SECURITY DEFINER resolver `platform_resolve_bootstrap_org` (migration 0038).
///
/// `auth_bootstrap_credentials` is FORCE RLS, so the app's non-owner `console_rt`
/// role cannot read a credential row by hash until `app.current_org` is armed —
/// but the org is exactly what we need to arm it. This resolver returns ONLY the
/// org_id (nothing else), breaking that chicken-and-egg without widening any read
/// surface. Returns `None` for an unknown hash.
pub(crate) async fn resolve_bootstrap_org(
    tx: &mut Transaction<'_, Postgres>,
    token_hash: &[u8],
) -> Result<Option<Uuid>, ProvisioningError> {
    Ok(
        sqlx::query_scalar("SELECT platform_resolve_bootstrap_org($1)")
            .bind(token_hash)
            .fetch_one(tx.as_mut())
            .await?,
    )
}

pub(crate) async fn count_user_passkeys_tx(
    tx: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
) -> Result<i64, ProvisioningError> {
    Ok(
        sqlx::query_scalar("SELECT COUNT(*) FROM auth_webauthn_credentials WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(tx.as_mut())
            .await?,
    )
}

/// Generate a uniformly random, phone-readable code grouped 5-5 using the OS CSPRNG.
pub(crate) fn generate_bootstrap_token() -> Result<BootstrapToken, ProvisioningError> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; OTP_LEN];
    rng.fill(&mut bytes).map_err(|_| {
        ProvisioningError::Conflict("CSPRNG unavailable for bootstrap token".to_owned())
    })?;
    let mut out = String::with_capacity(OTP_LEN + 1);
    for (index, &byte) in bytes.iter().enumerate() {
        if index == OTP_GROUP_LEN {
            out.push('-');
        }
        out.push(OTP_ALPHABET[usize::from(byte) % OTP_ALPHABET.len()] as char);
    }
    bytes.zeroize();
    Ok(BootstrapToken(SecretString::from(out)))
}

/// Generate a 256-bit high-entropy platform operator invite token (`cop_` + base64url).
pub(crate) fn generate_platform_invite_token() -> Result<BootstrapToken, ProvisioningError> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; PLATFORM_INVITE_RANDOM_BYTES];
    rng.fill(&mut bytes).map_err(|_| {
        ProvisioningError::Conflict("CSPRNG unavailable for invite token".to_owned())
    })?;
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    bytes.zeroize();
    let mut token = String::with_capacity(PLATFORM_INVITE_TOKEN_PREFIX.len() + encoded.len());
    token.push_str(PLATFORM_INVITE_TOKEN_PREFIX);
    token.push_str(&encoded);
    Ok(BootstrapToken(SecretString::from(token)))
}

pub(crate) fn hash_token(token: &str) -> Vec<u8> {
    digest(&SHA256, token.as_bytes()).as_ref().to_vec()
}

/// Domain-separated SHA-256 digest for platform operator invite tokens.
pub(crate) fn hash_platform_invite_token(token: &str) -> Vec<u8> {
    let mut ctx = DigestContext::new(&SHA256);
    ctx.update(PLATFORM_INVITE_HASH_DOMAIN);
    ctx.update(token.as_bytes());
    ctx.finish().as_ref().to_vec()
}

#[cfg(test)]
#[path = "token_tests.rs"]
mod tests;
