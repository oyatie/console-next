use super::row_context::RowContext;
use super::{AuditChainError, DOMAIN_ROW, TS_FORMAT, sha256};
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

/// One `audit_events` row, in the exact column set the chain hashes.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(super) struct AuditRow {
    pub(super) id: Uuid,
    pub(super) actor: Option<Uuid>,
    pub(super) action: String,
    pub(super) target_type: String,
    pub(super) target_id: String,
    pub(super) branch_id: Option<Uuid>,
    pub(super) org_id: Option<Uuid>,
    pub(super) before_snap: Option<serde_json::Value>,
    pub(super) after_snap: Option<serde_json::Value>,
    pub(super) trace_id: String,
    pub(super) span_id: String,
    pub(super) occurred_at: OffsetDateTime,
    pub(super) created_at: OffsetDateTime,
    #[sqlx(flatten)]
    pub(super) context: RowContext,
}

/// Length-prefix: `u32_be(len) ‖ bytes`. Concatenating a FIXED sequence of
/// length-prefixed fields is injective — every field is self-delimiting, so no
/// two distinct field tuples can produce the same byte string (this is what
/// defeats the `H(a‖b)` boundary-ambiguity class). A NULL field encodes as
/// `u32_be(0)`, distinct from any present value.
pub(super) fn lp(buf: &mut Vec<u8>, bytes: &[u8]) {
    // A field longer than u32::MAX cannot occur (Postgres row/field limits are
    // far below 4 GiB); the cast is saturating-safe in practice, and a truncated
    // length would only ever cause a verify MISMATCH, never a false match.
    let len = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(bytes);
}

/// Raw bytes of an optional UUID: 16 bytes when present, empty (→ LP length 0)
/// when NULL.
fn opt_uuid_bytes(value: &Option<Uuid>) -> &[u8] {
    match value {
        Some(uuid) => uuid.as_bytes(),
        None => &[],
    }
}

/// Deterministic JSON bytes for a JSONB snapshot, with object keys sorted in
/// CRATE-OWNED code. This must NOT rely on serde_json's Map ordering: the
/// `preserve_order`/`indexmap` feature IS enabled transitively in this workspace
/// (cedar-policy-core + sqlx-postgres pull it), so `Value::Object` is an
/// insertion-ordered `IndexMap`, not sorted. Re-serializing with plain
/// `serde_json::to_vec` would emit keys in JSONB-storage order — seal==verify
/// only by accident, and a dep bump flipping the feature would mass-fail every
/// existing seal. Sorting here makes the encoding independent of the Map
/// backing; scalars reuse serde_json's own deterministic serialization (only
/// object key ORDER is controlled here). NULL column → empty.
pub(super) fn canonical_json(
    value: &Option<serde_json::Value>,
) -> Result<Vec<u8>, AuditChainError> {
    match value {
        None => Ok(Vec::new()),
        Some(json) => {
            let mut out = Vec::new();
            write_canonical_json(json, &mut out)?;
            Ok(out)
        }
    }
}

fn write_canonical_json(
    value: &serde_json::Value,
    out: &mut Vec<u8>,
) -> Result<(), AuditChainError> {
    match value {
        serde_json::Value::Object(map) => {
            out.push(b'{');
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by_key(|(k, _)| *k);
            for (i, (key, child)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                // Key as a JSON string (serde's escaping), then ':' then value.
                serde_json::to_writer(&mut *out, key)
                    .map_err(|err| AuditChainError::Canonical(format!("json key: {err}")))?;
                out.push(b':');
                write_canonical_json(child, out)?;
            }
            out.push(b'}');
        }
        serde_json::Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical_json(item, out)?;
            }
            out.push(b']');
        }
        // Null / Bool / Number / String: serde's serialization is deterministic
        // and free of any key-order concern.
        scalar => serde_json::to_writer(&mut *out, scalar)
            .map_err(|err| AuditChainError::Canonical(format!("json scalar: {err}")))?,
    }
    Ok(())
}

/// Canonical timestamp string (forced UTC, fixed 9-digit sub-second).
pub(super) fn format_ts(ts: OffsetDateTime) -> Result<String, AuditChainError> {
    ts.to_offset(UtcOffset::UTC)
        .format(&TS_FORMAT)
        .map_err(|err| AuditChainError::Canonical(format!("timestamp format: {err}")))
}

/// `row_hash := SHA-256(DOMAIN_ROW ‖ LP(id) ‖ LP(actor) ‖ … ‖ LP(created_at))`.
pub(super) fn row_hash(row: &AuditRow) -> Result<[u8; 32], AuditChainError> {
    let mut buf = Vec::new();
    lp(&mut buf, row.id.as_bytes());
    lp(&mut buf, opt_uuid_bytes(&row.actor));
    lp(&mut buf, row.action.as_bytes());
    lp(&mut buf, row.target_type.as_bytes());
    lp(&mut buf, row.target_id.as_bytes());
    lp(&mut buf, opt_uuid_bytes(&row.branch_id));
    lp(&mut buf, opt_uuid_bytes(&row.org_id));
    lp(&mut buf, &canonical_json(&row.before_snap)?);
    lp(&mut buf, &canonical_json(&row.after_snap)?);
    lp(&mut buf, row.trace_id.as_bytes());
    lp(&mut buf, row.span_id.as_bytes());
    lp(&mut buf, format_ts(row.occurred_at)?.as_bytes());
    lp(&mut buf, format_ts(row.created_at)?.as_bytes());
    match row.context.row_hash_version {
        1 => Ok(sha256(DOMAIN_ROW, &buf)),
        2 => {
            row.context.append(&mut buf)?;
            Ok(sha256(b"console.audit-chain.row.v2", &buf))
        }
        _ => Err(AuditChainError::Canonical(
            "unknown audit row hash version".into(),
        )),
    }
}

#[cfg(test)]
mod tests;
