//! A field PATCH (`application/json-patch+json`) and a command's `expected`
//! facts against the current record. Input: `<ops or facts JSON>\0<current JSON>`.
//! Invariants: never panic; a patch whose every touched path is unreadable is
//! never accepted; `json_eq` is reflexive and symmetric.
#![no_main]

use console_platform_preconditions::{
    ActorClearance, Fact, PatchOp, Provenance, check_expected, check_patch, json_eq,
};
use libfuzzer_sys::fuzz_target;
use serde_json::Value;

fuzz_target!(|bytes: &[u8]| {
    let mut parts = bytes.splitn(2, |b| *b == 0);
    let (Some(ops), Some(current)) = (parts.next(), parts.next()) else {
        return;
    };
    let Ok(current) = serde_json::from_slice::<Value>(current) else {
        return;
    };
    assert!(json_eq(&current, &current));
    let provenance = Provenance::new("actor", "2026-10-07T00:00:00Z", ActorClearance::Visible);
    if let Ok(ops) = serde_json::from_slice::<Vec<PatchOp>>(ops) {
        let _ = check_patch(&ops, &current, &provenance, |_| true);
        let touches = ops.iter().any(|op| !matches!(op, PatchOp::Test { .. }));
        if touches {
            assert!(
                check_patch(&ops, &current, &provenance, |_| false).is_err(),
                "a write was accepted with every path unreadable"
            );
        }
    }
    if let Ok(value) = serde_json::from_slice::<Value>(ops) {
        assert_eq!(json_eq(&value, &current), json_eq(&current, &value));
    }
    if let Ok(facts) = serde_json::from_slice::<Vec<Fact>>(ops) {
        let required: Vec<&str> = facts.iter().map(|f| f.path.as_str()).collect();
        let _ = check_expected(&facts, &required, &current, &provenance, |_| true);
        if !facts.is_empty() {
            assert!(
                check_expected(&facts, &required, &current, &provenance, |_| false).is_err(),
                "expected facts were checked with every path unreadable"
            );
        }
    }
});
