//! E-mail addresses (전자세금계산서 전용 전자우편주소, 사업장 연락처).

use super::{canonical_serde, refusal};
use crate::KernelError;

/// A syntactically checked e-mail address with a lower-cased domain.
///
/// Deliberately shallow (no DNS, no RFC 5322 quoted locals): exactly one `@`,
/// a non-empty local part, a dotted domain, no whitespace, at most 254 chars.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Email(String);

impl Email {
    pub const CODE_INVALID: &'static str = "email_invalid";
    const MAX: usize = 254;

    /// # Errors
    /// `email_invalid` when the shape checks above fail.
    pub fn parse(raw: &str) -> Result<Self, KernelError> {
        let trimmed = raw.trim();
        let mut parts = trimmed.split('@');
        let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(refusal(Self::CODE_INVALID));
        };
        let domain = domain.to_ascii_lowercase();
        let ok = !local.is_empty()
            && trimmed.chars().count() <= Self::MAX
            && !trimmed.chars().any(char::is_whitespace)
            && domain.contains('.')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
            && !domain.contains("..");
        if !ok {
            return Err(refusal(Self::CODE_INVALID));
        }
        Ok(Self(format!("{local}@{domain}")))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn display(&self) -> String {
        self.0.clone()
    }
}
canonical_serde!(Email);

impl std::fmt::Debug for Email {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let domain = self.0.split('@').nth(1).unwrap_or_default();
        write!(f, "Email(***@{domain})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowercases_domain_and_refuses_shapes() {
        assert_eq!(
            Email::parse(" Xxx-019@example.com ").unwrap().as_str(),
            "Xxx-019@example.com"
        );
        assert_eq!(
            Email::parse("x-018@example.com").unwrap().to_string(),
            "x-018@example.com"
        );
        assert_eq!(
            Email::parse(" Tax@Mail.EXAMPLE.COM ").unwrap().as_str(),
            "Tax@mail.example.com"
        );
        assert_eq!(
            Email::parse("a@B.example").unwrap().to_string(),
            "a@b.example"
        );
        for bad in [
            "",
            "a",
            "a@b",
            "a@@b.kr",
            "@b.kr",
            "a x-020@example.com",
            "a@.kr",
            "a@b..kr",
            "a@@b.example",
            "@b.example",
            "a b@c.example",
            "a@.example",
            "a@b..example",
        ] {
            assert!(Email::parse(bad).is_err(), "{bad}");
        }
    }
}
