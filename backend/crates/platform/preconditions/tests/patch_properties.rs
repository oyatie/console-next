//! Property tests for the JSON Patch precondition checker: RFC 6902 §4.6
//! equality, and the 422 / 403 / 409 / ME-3 decisions over generated records
//! and patches. Default 256 cases; the nightly `fuzz` profile raises
//! `PROPTEST_CASES` (see `.config/nextest.toml`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_platform_preconditions::{
    ActorClearance, FIELD_CONFLICT, FORBIDDEN, PRECONDITION_MISSING, PatchOp, Provenance,
    check_patch, json_eq,
};
use proptest::prelude::*;
use serde_json::{Map, Value, json};

fn leaf() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(|n| json!(n)),
        (-1.0e12f64..1.0e12).prop_map(|f| json!(f)),
        "[a-z~/ 가-힣]{0,4}".prop_map(Value::String),
    ]
}

/// Keys include `~` and `/`, so pointers need RFC 6901 escaping.
fn key() -> impl Strategy<Value = String> {
    "[a-c~/]{1,3}"
}

fn value() -> impl Strategy<Value = Value> {
    leaf().prop_recursive(3, 24, 4, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..4).prop_map(Value::Array),
            prop::collection::btree_map(key(), inner, 0..4)
                .prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

fn record() -> impl Strategy<Value = Map<String, Value>> {
    prop::collection::btree_map(key(), value(), 1..6).prop_map(|m| m.into_iter().collect())
}

fn pointer(key: &str) -> String {
    format!("/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn who() -> Provenance {
    Provenance::new("Lee", "2026-10-06T09:00:00Z", ActorClearance::Visible)
}

fn readable(_: &str) -> bool {
    true
}

proptest! {
    #[test]
    fn json_eq_is_reflexive_symmetric_and_survives_the_wire(a in value(), b in value()) {
        prop_assert!(json_eq(&a, &a));
        prop_assert_eq!(json_eq(&a, &b), json_eq(&b, &a));
        let wire: Value = serde_json::from_str(&a.to_string()).unwrap();
        prop_assert!(json_eq(&a, &wire));
    }

    #[test]
    fn integers_equal_their_float_form(n in -(1i64 << 51)..(1i64 << 51)) {
        prop_assert!(json_eq(&json!(n), &json!(n as f64)));
        prop_assert!(!json_eq(&json!(n), &json!(n as f64 + 0.5)));
    }

    #[test]
    fn object_member_order_never_matters(m in record()) {
        let reversed: Map<String, Value> = m.clone().into_iter().rev().collect();
        prop_assert!(json_eq(&Value::Object(m), &Value::Object(reversed)));
    }

    /// ME-1: every touched path tested against the value the record holds,
    /// then replaced — always accepted.
    #[test]
    fn fresh_tests_always_pass(current in record(), new in prop::collection::vec(value(), 1..6)) {
        let mut ops = Vec::new();
        for ((k, v), new) in current.iter().zip(&new) {
            ops.push(PatchOp::Test { path: pointer(k), value: v.clone() });
            ops.push(PatchOp::Replace { path: pointer(k), value: new.clone() });
        }
        prop_assert_eq!(check_patch(&ops, &Value::Object(current), &who(), readable), Ok(()));
    }

    /// ME-8: a stale test with a write to a different value is a 409 naming
    /// exactly the stale paths, each with the value now on the record.
    #[test]
    fn stale_tests_conflict_on_exactly_their_paths(
        current in record(),
        stale_mask in prop::collection::vec(any::<bool>(), 6),
        base in value(),
        new in value(),
    ) {
        let mut ops = Vec::new();
        let mut stale = Vec::new();
        for ((k, v), is_stale) in current.iter().zip(&stale_mask) {
            let path = pointer(k);
            let tested = if *is_stale && !json_eq(&base, v) { stale.push(path.clone()); base.clone() } else { v.clone() };
            ops.push(PatchOp::Test { path: path.clone(), value: tested });
            ops.push(PatchOp::Replace { path, value: new.clone() });
        }
        let current = Value::Object(current);
        let result = check_patch(&ops, &current, &who(), readable);
        // ME-3: a write of the value already held is no conflict.
        stale.retain(|p| !json_eq(current.pointer(p).unwrap(), &new));
        if stale.is_empty() {
            prop_assert_eq!(result, Ok(()));
        } else {
            let refusal = result.unwrap_err();
            prop_assert_eq!((refusal.status, refusal.code), (409, FIELD_CONFLICT));
            let named: Vec<_> = refusal.errors.iter().map(|e| e.pointer.clone()).collect();
            prop_assert_eq!(named, stale.clone());
            for entry in &refusal.errors {
                prop_assert_eq!(entry.current.as_ref(), current.pointer(&entry.pointer));
            }
        }
    }

    /// ME-12: a write whose path (or an ancestor, or its `_rev`) was never
    /// tested first is a 422 naming it, whatever else the patch holds.
    #[test]
    fn an_untested_write_is_always_422(current in record(), k in key(), v in value(), test_after in any::<bool>()) {
        let path = pointer(&format!("untested{k}"));
        let mut ops = vec![PatchOp::Add { path: path.clone(), value: v.clone() }];
        if test_after {
            ops.push(PatchOp::Test { path: path.clone(), value: v });
        }
        let refusal = check_patch(&ops, &Value::Object(current), &who(), readable).unwrap_err();
        prop_assert_eq!((refusal.status, refusal.code), (422, PRECONDITION_MISSING));
        prop_assert!(refusal.errors.iter().any(|e| e.pointer == path));
    }

    /// ME-11: if anything at or under a tested path is unreadable the answer
    /// is a bare 403 — no value, no actor — even when the test would fail.
    #[test]
    fn an_unreadable_subtree_is_a_bare_403(current in record(), base in value(), deny_at in any::<prop::sample::Index>()) {
        let current = Value::Object(current);
        let (k, held) = current.as_object().unwrap().iter().next().map(|(k, v)| (k.clone(), v.clone())).unwrap();
        let tested = pointer(&k);
        let mut below = vec![tested.clone()];
        collect_pointers(&held, &tested, &mut below);
        let denied = below[deny_at.index(below.len())].clone();
        let ops = vec![
            PatchOp::Test { path: tested.clone(), value: base },
            PatchOp::Remove { path: tested.clone() },
        ];
        let refusal = check_patch(&ops, &current, &who(), |p| p != denied).unwrap_err();
        prop_assert_eq!((refusal.status, refusal.code), (403, FORBIDDEN));
        prop_assert!(refusal.errors.iter().all(|e| e.current.is_none() && e.actor.is_none()));
    }

    /// Hostile pointers and op mixes never panic the checker.
    #[test]
    fn arbitrary_patches_never_panic(
        current in value(),
        paths in prop::collection::vec("(/[a-c~0-9/]{0,3}){0,3}", 1..6),
        kinds in prop::collection::vec(0u8..6, 1..6),
        v in value(),
    ) {
        let ops: Vec<PatchOp> = paths.iter().zip(&kinds).map(|(p, k)| match k {
            0 => PatchOp::Test { path: p.clone(), value: v.clone() },
            1 => PatchOp::Add { path: p.clone(), value: v.clone() },
            2 => PatchOp::Replace { path: p.clone(), value: v.clone() },
            3 => PatchOp::Remove { path: p.clone() },
            4 => PatchOp::Move { from: paths[0].clone(), path: p.clone() },
            _ => PatchOp::Copy { from: paths[0].clone(), path: p.clone() },
        }).collect();
        let _ = check_patch(&ops, &current, &who(), |p| !p.contains('~'));
    }
}

fn collect_pointers(value: &Value, at: &str, out: &mut Vec<String>) {
    let children: Vec<(String, &Value)> = match value {
        Value::Object(m) => m.iter().map(|(k, v)| (pointer(k), v)).collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (format!("/{i}"), v))
            .collect(),
        _ => return,
    };
    for (seg, child) in children {
        let path = format!("{at}{seg}");
        out.push(path.clone());
        collect_pointers(child, &path, out);
    }
}
