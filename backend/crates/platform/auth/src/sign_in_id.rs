//! The sign-in ID `<아이디>@<회사 도메인>` (decisions #33). One rule for the
//! sign-in route, the 아이디 change and the invite: trim, lowercase, then ASCII
//! only. A non-ASCII character is refused, never transliterated, so the
//! normalised form is NFC by construction. The account UUID stays the only key;
//! this is a changeable label.

use console_kernel_core::OrgId;
use uuid::Uuid;

use crate::AuthError;

/// How long a replaced 아이디 still signs in (it stays searchable for good).
pub const SIGN_IN_ALIAS_DAYS: i64 = 90;

/// The 아이디 part: `[a-z0-9]`, plus `.`, `_`, `-` inside, never two separators
/// in a row, 1 to 32 characters. `None` when the input breaks the rule.
#[must_use]
pub fn normalize_login(raw: &str) -> Option<String> {
    let login = raw.trim().to_lowercase();
    let bytes = login.as_bytes();
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let sep = |b: u8| matches!(b, b'.' | b'_' | b'-');
    let ok = (1..=32).contains(&bytes.len())
        && bytes.iter().all(|&b| alnum(b) || sep(b))
        && alnum(bytes[0])
        && alnum(bytes[bytes.len() - 1])
        && !bytes.windows(2).any(|w| sep(w[0]) && sep(w[1]));
    ok.then_some(login)
}

/// The domain part: today the tenant slug (`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`).
pub fn normalize_company_domain(raw: &str) -> Option<String> {
    let domain = raw.trim().to_lowercase();
    let bytes = domain.as_bytes();
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let ok = (3..=40).contains(&bytes.len())
        && bytes.iter().all(|&b| alnum(b) || b == b'-')
        && alnum(bytes[0])
        && alnum(bytes[bytes.len() - 1]);
    ok.then_some(domain)
}

/// A whole sign-in ID, normalised; `None` when either part breaks its rule
/// (a bare 아이디 without `@domain` included: the client completes it).
#[must_use]
pub fn normalize_sign_in_id(raw: &str) -> Option<String> {
    let (login, domain) = raw.trim().split_once('@')?;
    Some(format!(
        "{}@{}",
        normalize_login(login)?,
        normalize_company_domain(domain)?
    ))
}

/// The account's current sign-in ID (`<아이디>@<slug>`), read with the tenant
/// GUC armed for `org`. `None` only for an account with no row, which the
/// migration and the default trigger make impossible after commit.
pub async fn current_sign_in_id(
    pool: &sqlx::PgPool,
    org: OrgId,
    user_id: Uuid,
) -> Result<Option<String>, AuthError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await?;
    let id = sqlx::query_scalar(
        "SELECT s.login || '@' || o.slug FROM user_sign_in_ids s \
           JOIN organizations o ON o.id = s.org_id \
          WHERE s.org_id = $1 AND s.user_id = $2 AND s.retired_at IS NULL",
    )
    .bind(*org.as_uuid())
    .bind(user_id)
    .fetch_optional(tx.as_mut())
    .await?;
    tx.commit().await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::{normalize_login, normalize_sign_in_id};

    #[test]
    fn logins_follow_the_mailbox_rule() {
        assert_eq!(
            normalize_login(" Hong.GilDong "),
            Some("hong.gildong".to_owned())
        );
        assert_eq!(normalize_login("e-000123"), Some("e-000123".to_owned()));
        assert_eq!(normalize_login("a"), Some("a".to_owned()));
        assert_eq!(normalize_login(&"a".repeat(32)), Some("a".repeat(32)));
        for bad in [
            "",
            ".hong",
            "hong.",
            "ho..ng",
            "ho._ng",
            "홍길동",
            "ｈｏｎｇ",
            "ho ng",
            "ho@ng",
            &"a".repeat(33),
        ] {
            assert_eq!(normalize_login(bad), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn a_sign_in_id_needs_both_parts() {
        assert_eq!(
            normalize_sign_in_id("Hong@ACME"),
            Some("hong@acme".to_owned())
        );
        assert_eq!(normalize_sign_in_id("hong"), None);
        assert_eq!(normalize_sign_in_id("hong@"), None);
        assert_eq!(normalize_sign_in_id("@acme"), None);
        assert_eq!(normalize_sign_in_id("hong@ac"), None);
        assert_eq!(normalize_sign_in_id("hong@-acme"), None);
        assert_eq!(normalize_sign_in_id("hong@acme@x"), None);
    }
}
