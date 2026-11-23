// SPDX-License-Identifier: LicenseRef-Proprietary
//! Canonical outer Associated Authenticated Data (AAD) for envelope AEAD.

use crate::error::CryptoError;
use crate::header::KekId;
use crate::suite::AlgId;

const OUTER_AAD_DOMAIN: &[u8] = b"console.crypto.aad.v1";

/// Full context bound into every v3 AWS-ESDK-v2 AES-256-GCM payload authentication tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvelopeContext<'a> {
    pub tenant_id: &'a str,
    pub table: &'a str,
    pub record: &'a str,
    pub field: &'a str,
    pub purpose: &'a str,
}

pub(crate) fn push_lp_u32(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), CryptoError> {
    let len = u32::try_from(bytes.len()).map_err(|_| CryptoError::InvalidInput)?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

/// Encode the canonical length-prefixed outer AAD binding header metadata and row context.
pub fn encode_outer_aad(
    alg_id: AlgId,
    kek_id: &KekId,
    wrapped_dek: &[u8],
    msg_id: &[u8; 32],
    commitment_tag: &[u8; 32],
    ctx: EnvelopeContext<'_>,
) -> Result<Vec<u8>, CryptoError> {
    if ctx.tenant_id.is_empty()
        || ctx.table.is_empty()
        || ctx.record.is_empty()
        || ctx.field.is_empty()
        || ctx.purpose.is_empty()
    {
        return Err(CryptoError::InvalidInput);
    }
    let capacity = OUTER_AAD_DOMAIN.len()
        + 2
        + 4 * 9
        + kek_id.as_bytes().len()
        + wrapped_dek.len()
        + msg_id.len()
        + commitment_tag.len()
        + ctx.tenant_id.len()
        + ctx.table.len()
        + ctx.record.len()
        + ctx.field.len()
        + ctx.purpose.len();
    let mut out = Vec::with_capacity(capacity);
    out.extend_from_slice(OUTER_AAD_DOMAIN);
    out.extend_from_slice(&alg_id.as_u16().to_be_bytes());
    push_lp_u32(&mut out, kek_id.as_bytes())?;
    push_lp_u32(&mut out, wrapped_dek)?;
    push_lp_u32(&mut out, msg_id)?;
    push_lp_u32(&mut out, commitment_tag)?;
    push_lp_u32(&mut out, ctx.tenant_id.as_bytes())?;
    push_lp_u32(&mut out, ctx.table.as_bytes())?;
    push_lp_u32(&mut out, ctx.record.as_bytes())?;
    push_lp_u32(&mut out, ctx.field.as_bytes())?;
    push_lp_u32(&mut out, ctx.purpose.as_bytes())?;
    Ok(out)
}
