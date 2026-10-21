use super::BootstrapToken;
use crate::ProvisioningError;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

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

/// Admin-issued OTP length and alphabet.
///
/// 8 characters over a 72-symbol copy-paste-safe alphabet: A-Z, a-z, 0-9 and the
/// special set `!@#$%^&*-_`. That is 72^8 ≈ 2^49.3 of entropy. Eight characters
/// is the product's explicit choice; the brute-force guarantee therefore rests on
/// the per-client rate limit plus the short (default 24h, configurable) TTL and
/// single-use-on-success consume, NOT on the token length alone.
const OTP_LEN: usize = 8;
const OTP_ALPHABET: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_";

/// Generate a cryptographically-random 8-character OTP using rejection sampling
/// over [`OTP_ALPHABET`] so every symbol is equiprobable (no modulo bias).
pub(crate) fn generate_bootstrap_token() -> BootstrapToken {
    let alphabet_len = OTP_ALPHABET.len();
    // Largest multiple of the alphabet length that fits in a byte; bytes at or
    // above this are rejected to keep the distribution uniform.
    let limit = (256 / alphabet_len) * alphabet_len;
    let mut out = String::with_capacity(OTP_LEN);
    while out.len() < OTP_LEN {
        for &byte in fill_random().iter() {
            if (byte as usize) < limit {
                out.push(OTP_ALPHABET[byte as usize % alphabet_len] as char);
                if out.len() == OTP_LEN {
                    break;
                }
            }
        }
    }
    BootstrapToken(out)
}

/// 16 cryptographically-random bytes. `Uuid::new_v4` draws from the OS CSPRNG via
/// `getrandom`, so this reuses the project's existing randomness source without a
/// new dependency.
fn fill_random() -> [u8; 16] {
    *Uuid::new_v4().as_bytes()
}

pub(crate) fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}
