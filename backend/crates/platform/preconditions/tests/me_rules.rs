//! One case per server-side row of concurrent-editing.md §1 (ME-1, ME-2,
//! ME-3, ME-7) and per checker item of §5 (`_rev`, unreadable test → 403,
//! no leak in 409, no test → 422), plus the ME-9 round trip.

use console_platform_preconditions::{
    ActorClearance, Fact, PatchOp, Provenance, Refusal, check_expected, check_patch,
};
use serde_json::{Value, json};

/// The record as the server holds it now. `rrn` is masked for the caller.
fn record() -> Value {
    json!({
        "name": "Kim",
        "phone": "010-2222",
        "grade": 3,
        "pay": 1.5,
        "rrn": "900101-1234567",
        "rrn_rev": "r2",
        "tags": ["a"],
        "note": null,
        "state": "PENDING",
        "content_rev": "c7"
    })
}

fn can_read(path: &str) -> bool {
    path != "/rrn"
}

fn by_lee() -> Provenance {
    Provenance::new("Lee", "2026-10-02T09:00:00Z", ActorClearance::Visible)
}

fn ops(wire: Value) -> Vec<PatchOp> {
    serde_json::from_value(wire).unwrap_or_default()
}

/// A command's `expected` facts against the record.
fn expect(wire: Value, required: &[&str]) -> Result<(), Refusal> {
    let facts: Vec<Fact> = serde_json::from_value(wire).unwrap_or_default();
    check_expected(&facts, required, &record(), &by_lee(), can_read)
}

fn patch(wire: Value) -> Result<(), Refusal> {
    let ops = ops(wire);
    assert!(!ops.is_empty(), "test patch must parse");
    check_patch(&ops, &record(), &by_lee(), can_read)
}

#[test]
fn me1_change_to_an_untouched_field_is_no_conflict() {
    // Someone changed phone (010-1111 → 010-2222); this user edited name only.
    assert_eq!(
        patch(json!([
            {"op": "test", "path": "/name", "value": "Kim"},
            {"op": "replace", "path": "/name", "value": "Park"}
        ])),
        Ok(())
    );
}

#[test]
fn me2_same_field_different_value_is_field_conflict_naming_it() {
    let refusal = patch(json!([
        {"op": "test", "path": "/phone", "value": "010-1111"},
        {"op": "replace", "path": "/phone", "value": "010-3333"},
        {"op": "test", "path": "/name", "value": "Kim"},
        {"op": "replace", "path": "/name", "value": "Park"}
    ]))
    .err();
    let body = serde_json::to_value(refusal).unwrap_or_default();
    assert_eq!(
        body,
        json!({
            "status": 409,
            "code": "field_conflict",
            "errors": [{
                "pointer": "/phone",
                "code": "field_conflict",
                "current": "010-2222",
                "actor": "Lee",
                "at": "2026-10-02T09:00:00Z"
            }]
        })
    );
}

#[test]
fn me3_same_value_already_applied_is_no_conflict() {
    assert_eq!(
        patch(json!([
            {"op": "test", "path": "/phone", "value": "010-1111"},
            {"op": "replace", "path": "/phone", "value": "010-2222"}
        ])),
        Ok(())
    );
    // Same value, but a second op also touches the path: no shortcut.
    let refusal = patch(json!([
        {"op": "test", "path": "/tags", "value": []},
        {"op": "replace", "path": "/tags", "value": ["a"]},
        {"op": "add", "path": "/tags/-", "value": "b"}
    ]));
    assert_eq!(refusal.map_err(|r| r.code), Err("field_conflict"));
}

#[test]
fn me7_stale_fact_is_stale_facts_and_fresh_facts_pass() {
    let required = ["/state", "/content_rev"];
    let fresh = json!([
        {"path": "/state", "value": "PENDING"},
        {"path": "/content_rev", "value": "c7"}
    ]);
    assert_eq!(expect(fresh, &required), Ok(()));

    let stale = json!([
        {"path": "/state", "value": "PENDING"},
        {"path": "/content_rev", "value": "c6"}
    ]);
    let body = serde_json::to_value(expect(stale, &required).err()).unwrap_or_default();
    assert_eq!(body["status"], 409);
    assert_eq!(body["code"], "stale_facts");
    assert_eq!(body["errors"][0]["pointer"], "/content_rev");
    assert_eq!(body["errors"][0]["current"], "c7");
    assert_eq!(body["errors"].as_array().map(Vec::len), Some(1));
}

#[test]
fn me7_missing_required_fact_or_empty_expected_is_precondition_missing() {
    let partial = json!([{"path": "/state", "value": "PENDING"}]);
    let refusal = expect(partial, &["/state", "/content_rev"]).err();
    assert_eq!(
        refusal.as_ref().map(|r| (r.status, r.code)),
        Some((422, "precondition_missing"))
    );
    assert_eq!(
        refusal.map(|r| r.errors[0].pointer.clone()),
        Some("/content_rev".to_owned())
    );
    assert_eq!(expect(json!([]), &[]).map_err(|r| r.status), Err(422));
}

#[test]
fn me10_masked_field_is_tested_through_its_rev() {
    assert_eq!(
        patch(json!([
            {"op": "test", "path": "/rrn_rev", "value": "r2"},
            {"op": "replace", "path": "/rrn", "value": "900101-7654321"}
        ])),
        Ok(())
    );
    // Stale rev: the 409 carries the token, never the masked value, and the
    // same-value shortcut does not apply even when the new value matches.
    let refusal = patch(json!([
        {"op": "test", "path": "/rrn_rev", "value": "r1"},
        {"op": "replace", "path": "/rrn", "value": "900101-1234567"}
    ]));
    let body = serde_json::to_value(refusal.err()).unwrap_or_default();
    assert_eq!(body["code"], "field_conflict");
    assert_eq!(body["errors"][0]["current"], "r2");
    assert!(!body.to_string().contains("1234567"));
}

#[test]
fn me11_unreadable_test_is_403_and_not_evaluated() {
    // Value test on the masked field, whether it would pass or fail.
    for guess in ["900101-1234567", "000000-0000000"] {
        let refusal = patch(json!([
            {"op": "test", "path": "/rrn", "value": guess},
            {"op": "replace", "path": "/rrn", "value": "x"}
        ]));
        assert_eq!(
            refusal.map_err(|r| (r.status, r.code)),
            Err((403, "forbidden"))
        );
    }
    // A readable ancestor whose subtree holds the masked field is refused
    // too, so a 409 on "" can never echo the RRN.
    let refusal = patch(json!([
        {"op": "test", "path": "", "value": {}},
        {"op": "replace", "path": "/name", "value": "Park"}
    ]));
    let body = serde_json::to_value(refusal.err()).unwrap_or_default();
    assert_eq!(body["status"], 403);
    assert!(!body.to_string().contains("1234567"));
    // An unreadable fact is refused the same way.
    let refusal = expect(json!([{"path": "/rrn", "value": "x"}]), &[]);
    assert_eq!(refusal.map_err(|r| r.status), Err(403));
}

#[test]
fn me11_copy_from_an_unreadable_path_is_403() {
    let refusal = patch(json!([
        {"op": "test", "path": "/rrn_rev", "value": "r2"},
        {"op": "test", "path": "/name", "value": "Kim"},
        {"op": "copy", "from": "/rrn", "path": "/name"}
    ]));
    assert_eq!(refusal.map_err(|r| r.status), Err(403));
}

#[test]
fn me12_write_without_a_preceding_test_is_precondition_missing() {
    let cases = [
        json!([{"op": "replace", "path": "/name", "value": "Park"}]),
        // A test after the write does not count.
        json!([
            {"op": "replace", "path": "/name", "value": "Park"},
            {"op": "test", "path": "/name", "value": "Kim"}
        ]),
        // A test on a sibling does not cover it.
        json!([
            {"op": "test", "path": "/name_x", "value": "Kim"},
            {"op": "remove", "path": "/name"}
        ]),
        json!([
            {"op": "test", "path": "/phone", "value": "010-2222"},
            {"op": "move", "from": "/name", "path": "/phone"}
        ]),
    ];
    for wire in cases {
        let refusal = patch(wire);
        assert_eq!(
            refusal.as_ref().map_err(|r| (r.status, r.code)),
            Err((422, "precondition_missing"))
        );
        assert_eq!(
            refusal.map_err(|r| r.errors[0].pointer.clone()),
            Err("/name".to_owned())
        );
    }
    // An ancestor test covers an array append.
    assert_eq!(
        patch(json!([
            {"op": "test", "path": "/tags", "value": ["a"]},
            {"op": "add", "path": "/tags/-", "value": "b"}
        ])),
        Ok(())
    );
}

#[test]
fn me9_get_then_unchanged_patch_round_trip_never_conflicts() {
    // What the server sends, as the client parses it back.
    let wire = serde_json::to_string(&record()).unwrap_or_default();
    let seen: Value = serde_json::from_str(&wire).unwrap_or_default();
    let mut test_ops = Vec::new();
    for (key, value) in seen.as_object().into_iter().flatten() {
        if can_read(&format!("/{key}")) {
            test_ops.push(json!({"op": "test", "path": format!("/{key}"), "value": value}));
        }
    }
    assert!(test_ops.len() > 5);
    assert_eq!(patch(Value::Array(test_ops)), Ok(()));
    // A client that re-encodes 3 as 3.0 still matches.
    assert_eq!(
        patch(json!([
            {"op": "test", "path": "/grade", "value": 3.0},
            {"op": "replace", "path": "/grade", "value": 4}
        ])),
        Ok(())
    );
}

#[test]
fn absent_and_null_are_distinct_in_the_409() {
    let refusal = patch(json!([
        {"op": "test", "path": "/note", "value": "x"},
        {"op": "test", "path": "/gone", "value": "x"},
        {"op": "replace", "path": "/note", "value": "y"}
    ]));
    let body = serde_json::to_value(refusal.err()).unwrap_or_default();
    assert_eq!(
        body["errors"][0],
        json!({
            "pointer": "/note", "code": "field_conflict", "current": null,
            "actor": "Lee", "at": "2026-10-02T09:00:00Z"
        })
    );
    assert_eq!(body["errors"][1].get("current"), None);
}

#[test]
fn od_rt_3_covert_or_unset_actor_is_hidden() {
    let covert = Provenance::new("Lee", "2026-10-02T09:00:00Z", ActorClearance::Covert);
    let wire = ops(json!([
        {"op": "test", "path": "/name", "value": "Choi"},
        {"op": "replace", "path": "/name", "value": "Park"}
    ]));
    for provenance in [covert, Provenance::default()] {
        let refusal = check_patch(&wire, &record(), &provenance, can_read).err();
        let body = serde_json::to_value(refusal).unwrap_or_default();
        assert_eq!(body["errors"][0]["current"], "Kim");
        assert_eq!(body["errors"][0].get("actor"), None);
    }
}
