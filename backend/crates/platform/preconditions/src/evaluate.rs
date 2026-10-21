//! The checks, in refusal order: 422 missing precondition (ME-12), then 403
//! unreadable path (ME-11, nothing evaluated), then 409 conflict (ME-8/ME-7).

use serde_json::Value;

use crate::canonical::json_eq;
use crate::refusal::{FIELD_CONFLICT, Provenance, Refusal, STALE_FACTS};
use crate::{Fact, PatchOp};

/// Check a field PATCH against the current record.
///
/// `can_read(pointer)` is the caller's Cedar read check for one record path.
/// It must answer `false` for a masked field's value (ME-10), so such a field
/// can only be tested through its `<field>_rev` sibling.
///
/// # Errors
/// 422 `precondition_missing` when a write has no preceding `test` on its
/// path, an ancestor of it, or its `_rev` sibling; 403 `forbidden` when a
/// tested or copied path (or anything under it) is unreadable; 409
/// `field_conflict` with one entry per failed `test`.
pub fn check_patch(
    ops: &[PatchOp],
    current: &Value,
    provenance: &Provenance,
    can_read: impl Fn(&str) -> bool,
) -> Result<(), Refusal> {
    let mut tested: Vec<&str> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for op in ops {
        if let PatchOp::Test { path, .. } = op {
            tested.push(path);
        }
        for path in op.touched() {
            let covered = tested
                .iter()
                .any(|t| *t == rev_of(path) || is_within(path, t));
            if !covered && !missing.iter().any(|m| m == path) {
                missing.push(path.to_owned());
            }
        }
    }
    if !missing.is_empty() {
        return Err(Refusal::missing(missing));
    }

    let read_paths = ops.iter().filter_map(|op| match op {
        PatchOp::Test { path, .. } => Some(path.as_str()),
        PatchOp::Copy { from, .. } | PatchOp::Move { from, .. } => Some(from.as_str()),
        _ => None,
    });
    guard_reads(read_paths, current, &can_read)?;

    let conflicts: Vec<_> = ops
        .iter()
        .filter_map(|op| match op {
            PatchOp::Test { path, value } => Some((path.as_str(), value)),
            _ => None,
        })
        .filter(|(path, base)| !holds(current, path, base) && !already_applied(ops, current, path))
        .map(|(path, _)| provenance.entry(FIELD_CONFLICT, path, current.pointer(path)))
        .collect();
    finish(FIELD_CONFLICT, conflicts)
}

/// Check a command's `expected` facts against the current record (ME-7).
///
/// `required` lists the fact paths this command must assert (for a decision:
/// state, step and `content_rev`, spec A8). An empty `expected` is always
/// refused.
///
/// # Errors
/// 422 `precondition_missing` naming each required path not asserted; 403
/// `forbidden` for an unreadable fact path; 409 `stale_facts` with one entry
/// per changed fact.
pub fn check_expected(
    expected: &[Fact],
    required: &[&str],
    current: &Value,
    provenance: &Provenance,
    can_read: impl Fn(&str) -> bool,
) -> Result<(), Refusal> {
    let missing: Vec<String> = required
        .iter()
        .filter(|r| !expected.iter().any(|f| f.path == **r))
        .map(|r| (*r).to_owned())
        .collect();
    if expected.is_empty() || !missing.is_empty() {
        return Err(Refusal::missing(missing));
    }

    guard_reads(expected.iter().map(|f| f.path.as_str()), current, &can_read)?;

    let stale: Vec<_> = expected
        .iter()
        .filter(|f| !holds(current, &f.path, &f.value))
        .map(|f| provenance.entry(STALE_FACTS, &f.path, current.pointer(&f.path)))
        .collect();
    finish(STALE_FACTS, stale)
}

fn finish(code: &'static str, entries: Vec<crate::Entry>) -> Result<(), Refusal> {
    if entries.is_empty() {
        Ok(())
    } else {
        Err(Refusal::conflict(code, entries))
    }
}

fn holds(current: &Value, path: &str, base: &Value) -> bool {
    current.pointer(path).is_some_and(|now| json_eq(now, base))
}

/// ME-3: the test failed, but the patch's only change at `path` is a
/// `replace` to the value already there, or a `remove` of a value already
/// gone. Anything else touching the path or its subtree counts as a conflict.
/// A `_rev` test never qualifies: its write is on another path, and comparing
/// a masked value would be a read oracle (ME-11).
fn already_applied(ops: &[PatchOp], current: &Value, path: &str) -> bool {
    let mut related = ops.iter().filter(|op| {
        op.touched()
            .iter()
            .any(|p| is_within(p, path) || is_within(path, p))
    });
    match (related.next(), related.next()) {
        (Some(PatchOp::Replace { path: p, value }), None) if p == path => {
            holds(current, path, value)
        }
        (Some(PatchOp::Remove { path: p }), None) if p == path => current.pointer(path).is_none(),
        _ => false,
    }
}

/// ME-11: each path and every pointer below it in the current record must be
/// readable, or the whole request is refused before anything is compared.
fn guard_reads<'a>(
    paths: impl Iterator<Item = &'a str>,
    current: &Value,
    can_read: &impl Fn(&str) -> bool,
) -> Result<(), Refusal> {
    for path in paths {
        let readable = match current.pointer(path) {
            Some(value) => subtree_readable(value, &mut path.to_owned(), can_read),
            None => can_read(path),
        };
        if !readable {
            return Err(Refusal::forbidden(path));
        }
    }
    Ok(())
}

fn subtree_readable(value: &Value, at: &mut String, can_read: &impl Fn(&str) -> bool) -> bool {
    if !can_read(at) {
        return false;
    }
    let children: Vec<(String, &Value)> = match value {
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| (k.replace('~', "~0").replace('/', "~1"), v))
            .collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => return true,
    };
    children.into_iter().all(|(segment, child)| {
        let len = at.len();
        at.push('/');
        at.push_str(&segment);
        let ok = subtree_readable(child, at, can_read);
        at.truncate(len);
        ok
    })
}

/// `path` equals `ancestor` or lies under it (`""` is the whole record).
fn is_within(path: &str, ancestor: &str) -> bool {
    path.strip_prefix(ancestor)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

fn rev_of(path: &str) -> String {
    format!("{path}_rev")
}
