//! The pure checks every reason-bearing command and the catalog admin run:
//! is the code known and active, is the note present when required, is a new
//! tenant code well-formed. The adapter loads the tenant's codes; nothing
//! here touches IO.

use super::{ReasonDomain, ReasonError};
use uuid::Uuid;

/// Longest note, in characters. A storage bound shared with the migration's
/// `CHECK`s (X6), not a tenant policy.
pub const NOTE_MAX_CHARS: usize = 1000;
/// Longest tenant code label, in characters (storage bound, as above).
pub const LABEL_MAX_CHARS: usize = 60;
/// Tenant codes live in their own namespace, so they never collide with a
/// system code added later.
pub const TENANT_CODE_PREFIX: &str = "T_";

/// One tenant-added code of a domain, as the adapter loads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantCode {
    pub code: String,
    pub requires_note: bool,
    pub active: bool,
}

/// A checked reason, ready to store: `note` is trimmed, `None` when blank.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidReason {
    pub domain: ReasonDomain,
    pub code: String,
    pub note: Option<String>,
}

/// A checked new tenant code (labels trimmed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTenantCode {
    pub domain: ReasonDomain,
    pub code: String,
    pub label_ko: String,
    pub label_en: Option<String>,
    pub requires_note: bool,
}

/// Parse a domain string from the wire.
///
/// # Errors
/// [`ReasonError::DomainUnknown`].
pub fn parse_domain(raw: &str) -> Result<ReasonDomain, ReasonError> {
    raw.parse()
        .map_err(|_| ReasonError::DomainUnknown(raw.to_owned()))
}

/// Check a command's `reason_code` and `reason_note` against `domain`'s system
/// codes and the tenant's codes of that domain (`tenant`).
///
/// # Errors
/// - [`ReasonError::CodeInvalid`]: unknown code, or an inactive tenant code.
/// - [`ReasonError::NoteTooLong`].
/// - [`ReasonError::NoteRequired`]: the code requires a note; blank is none.
pub fn validate_reason(
    domain: ReasonDomain,
    code: &str,
    note: Option<&str>,
    tenant: &[TenantCode],
) -> Result<ValidReason, ReasonError> {
    let requires_note = domain
        .system_codes()
        .iter()
        .find(|c| c.code == code)
        .map(|c| c.requires_note)
        .or_else(|| {
            tenant
                .iter()
                .find(|t| t.active && t.code == code && is_tenant_code(code))
                .map(|t| t.requires_note)
        })
        .ok_or_else(|| ReasonError::CodeInvalid {
            domain,
            code: code.to_owned(),
        })?;
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.chars().count() > NOTE_MAX_CHARS) {
        return Err(ReasonError::NoteTooLong);
    }
    if requires_note && note.is_none() {
        return Err(ReasonError::NoteRequired {
            domain,
            code: code.to_owned(),
        });
    }
    Ok(ValidReason {
        domain,
        code: code.to_owned(),
        note: note.map(str::to_owned),
    })
}

/// Check an admin's new tenant code. `id` names the row; the code is derived
/// from it, so it is unique and inside the tenant namespace.
///
/// # Errors
/// [`ReasonError::LabelInvalid`] for a blank or over-long label.
pub fn check_new_tenant_code(
    domain: ReasonDomain,
    id: Uuid,
    label_ko: &str,
    label_en: Option<&str>,
    requires_note: bool,
) -> Result<NewTenantCode, ReasonError> {
    let label = |raw: &str, field| {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.chars().count() > LABEL_MAX_CHARS {
            Err(ReasonError::LabelInvalid { field })
        } else {
            Ok(trimmed.to_owned())
        }
    };
    Ok(NewTenantCode {
        domain,
        code: tenant_code(id),
        label_ko: label(label_ko, "label_ko")?,
        label_en: label_en.map(|l| label(l, "label_en")).transpose()?,
        requires_note,
    })
}

/// Check that `code` may be switched active/inactive by a tenant.
///
/// # Errors
/// [`ReasonError::SystemCodeFixed`] for a system code.
// system codes are always active (no per-tenant hide); add a
// tenant visibility row if customers ask to hide one.
pub fn check_toggle(domain: ReasonDomain, code: &str) -> Result<(), ReasonError> {
    if domain.system_codes().iter().any(|c| c.code == code) {
        return Err(ReasonError::SystemCodeFixed {
            domain,
            code: code.to_owned(),
        });
    }
    Ok(())
}

/// The tenant code for row `id`: `T_` and 32 upper-case hex digits. The
/// migration's `CHECK (code ~ '^T_[0-9A-F]{32}$')` is the same predicate.
#[must_use]
pub fn tenant_code(id: Uuid) -> String {
    format!("{TENANT_CODE_PREFIX}{:X}", id.simple())
}

/// True when `code` is in the tenant namespace (see [`tenant_code`]).
#[must_use]
pub fn is_tenant_code(code: &str) -> bool {
    code.strip_prefix(TENANT_CODE_PREFIX).is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
    })
}

/// True when `code` has the stored shape of any reason code, system or
/// tenant. The migration's `reason_code_well_formed()` is the same predicate.
#[must_use]
pub fn is_well_formed(code: &str) -> bool {
    let mut bytes = code.bytes();
    code.len() <= 64
        && bytes.next().is_some_and(|b| b.is_ascii_uppercase())
        && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
