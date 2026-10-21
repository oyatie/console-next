//! Fingerprints allow a fresh refusal to name changed lines without storing personal preview data.
use crate::Preview;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

fn hash(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) fn lines(p: &Preview) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (kind, items) in [("B", &p.blockers), ("W", &p.warnings)] {
        for i in items {
            out.insert(i.code.to_owned(), hash(&format!("{kind}|{i:?}")));
        }
    }
    for (key, value) in [
        ("phase", p.phase.to_owned()),
        ("facts", format!("{:?}", p.facts)),
        ("becomes_governed", format!("{:?}", p.becomes_governed)),
        ("breakdown", format!("{:?}", p.details.breakdown)),
        (
            "roles_becoming_active",
            format!("{:?}", p.details.roles_becoming_active),
        ),
        (
            "access_admin_holders",
            format!("{:?}", p.details.access_admin_holders),
        ),
        (
            "hr_accounts_with_no_grant",
            format!("{:?}", p.details.hr_accounts_with_no_grant),
        ),
        ("terms_version", format!("{:?}", p.details.terms_version)),
    ] {
        out.insert(key.to_owned(), hash(&value));
    }
    out
}

/// SHA-256 of the canonical fingerprint map; a client's old map must match its old digest.
#[must_use]
pub fn digest_lines(lines: &BTreeMap<String, String>) -> String {
    let mut h = Sha256::new();
    for (key, value) in lines {
        h.update(key.len().to_be_bytes());
        h.update(key.as_bytes());
        h.update(value.len().to_be_bytes());
        h.update(value.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn digest(p: &Preview) -> String {
    digest_lines(&lines(p))
}

/// Compare only a digest-bound previous map. An absent or invalid map marks every current line for review.
#[must_use]
pub fn changed_codes(
    current: &Preview,
    digest: &str,
    seen: &BTreeMap<String, String>,
) -> Vec<String> {
    if seen.len() > 128 || digest_lines(seen) != digest {
        return current.line_digests.keys().cloned().collect();
    }
    seen.keys()
        .chain(current.line_digests.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|key| seen.get(*key) != current.line_digests.get(*key))
        .cloned()
        .collect()
}
