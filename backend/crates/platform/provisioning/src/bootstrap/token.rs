use super::BootstrapToken;
use crate::ProvisioningError;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

#[path = "format.rs"]
mod format;
pub use format::*;

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

/// Generate a uniformly random, phone-readable code grouped 5-5.
pub(crate) fn generate_bootstrap_token() -> BootstrapToken {
    let mut out = String::with_capacity(OTP_LEN + 1);
    for group in 0..OTP_LEN / OTP_GROUP_LEN {
        if group > 0 {
            out.push('-');
        }
        let random = Uuid::new_v4();
        // UUID byte six has fixed bits; base32 evenly divides each preceding random byte.
        for &byte in &random.as_bytes()[..OTP_GROUP_LEN] {
            out.push(OTP_ALPHABET[usize::from(byte) % OTP_ALPHABET.len()] as char);
        }
    }
    BootstrapToken(out)
}

pub(crate) fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
#[path = "token_tests.rs"]
mod tests;
