//! Reason-code catalog (BW-07, product-wide R2).
//!
//! Every reason-bearing command takes a `reason_code` from one
//! [`ReasonDomain`] and an optional note. System codes are code-defined
//! here; tenants add their own codes inline (no deploy) in the `T_`
//! namespace. An unknown or inactive code is `reason_code_invalid`; a code
//! with `requires_note` ([`OTHER`] always) without a note is
//! `reason_note_required`. Existing free-text columns are the note.
//!
//! Layer: domain. Pure; the adapter loads tenant codes and passes them in.

mod error;
mod roster;
#[cfg(test)]
mod tests;
mod validate;

pub use error::ReasonError;
pub use roster::{OTHER, ReasonDomain, SystemCode, UnknownDomain};
pub use validate::{
    LABEL_MAX_CHARS, NOTE_MAX_CHARS, NewTenantCode, TENANT_CODE_PREFIX, TenantCode, ValidReason,
    check_new_tenant_code, check_toggle, is_tenant_code, is_well_formed, parse_domain, tenant_code,
    validate_reason,
};
