// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_kernel_core::OrgId;
use console_platform_authz::CedarEvaluation;
use console_platform_authz::cedar_pbac::engine::{
    CompiledBundle, compile_bundle_from_sources, evaluate_entities,
};
use serde_json::{Value, json};

const SCHEMA: &str = include_str!("../../../ops/rest/cedar/ops.cedarschema");
const POLICY: &str = include_str!("../../../ops/rest/cedar/ops.cedar");
const OPERATOR: &str = "Ops::Operator::\"00000000-0000-4000-8000-000000000001\"";
const CONSOLE: &str = "Ops::Console::\"console-1\"";
const ACTIONS: &[&str] = &[
    "read.me",
    "read.home",
    "read.alerts",
    "read.running",
    "read.sources",
];

fn bundle(policy: &str) -> CompiledBundle {
    compile_bundle_from_sources(OrgId::one(), 1, "ops-v1", SCHEMA, policy).unwrap()
}

fn grant(action: &str, from: i64, until: i64) -> Value {
    json!({"action": {"__entity": {"type": "Ops::Action", "id": action}}, "from": from, "until": until})
}

fn entities(grants: Value) -> Value {
    json!([
        {"uid": {"type": "Ops::Operator", "id": "00000000-0000-4000-8000-000000000001"},
         "attrs": {"grants": grants}, "parents": []},
        {"uid": {"type": "Ops::Console", "id": "console-1"}, "attrs": {}, "parents": []}
    ])
}

fn decide(
    bundle: &CompiledBundle,
    action: &str,
    grants: Value,
    selected: Value,
    now: i64,
) -> CedarEvaluation {
    evaluate_entities(
        bundle,
        OPERATOR,
        &format!("Ops::Action::\"{action}\""),
        CONSOLE,
        entities(grants),
        json!({"now": now, "grant": selected}),
    )
}

#[test]
fn ops_each_read_requires_its_own_live_grant() {
    let bundle = bundle(POLICY);
    for action in ACTIONS {
        let selected = grant(action, 100, 200);
        assert!(
            matches!(
                decide(&bundle, action, json!([selected]), selected.clone(), 150),
                CedarEvaluation::Allow { .. }
            ),
            "{action}"
        );
        assert!(
            matches!(
                decide(&bundle, action, json!([]), selected, 150),
                CedarEvaluation::Deny { .. }
            ),
            "{action} without grant"
        );
        for other in ACTIONS.iter().filter(|other| *other != action) {
            let selected = grant(other, 100, 200);
            assert!(
                matches!(
                    decide(&bundle, action, json!([selected]), selected.clone(), 150),
                    CedarEvaluation::Deny { .. }
                ),
                "{other} must not allow {action}"
            );
        }
    }
}

#[test]
fn ops_denial_preserves_deciding_policy_reason_annotations() {
    for (annotation, expected) in [
        ("@reason(\"ops_read_forbidden\")", "ops_read_forbidden"),
        ("", "cedar denied: no matching permit"),
    ] {
        let bundle = bundle(&format!(
            "{POLICY}\n{annotation}\nforbid(principal, action, resource);"
        ));
        let selected = grant("read.home", 100, 200);
        let result = decide(
            &bundle,
            "read.home",
            json!([selected]),
            selected.clone(),
            150,
        );
        assert!(
            matches!(result, CedarEvaluation::Deny { ref reason, .. } if reason == expected),
            "{result:?}"
        );
    }
}

#[test]
fn ops_grant_dates_are_start_inclusive_end_exclusive() {
    let bundle = bundle(POLICY);
    for (now, allowed) in [
        (99, false),
        (100, true),
        (199, true),
        (200, false),
        (201, false),
    ] {
        let selected = grant("read.home", 100, 200);
        let result = decide(
            &bundle,
            "read.home",
            json!([selected]),
            selected.clone(),
            now,
        );
        assert_eq!(
            matches!(result, CedarEvaluation::Allow { .. }),
            allowed,
            "{now}: {result:?}"
        );
    }
}

#[test]
fn ops_selected_grant_must_belong_to_this_operator_without_changed_dates() {
    let bundle = bundle(POLICY);
    let selected = grant("read.home", 100, 200);
    let stored = grant("read.home", 0, 100);
    assert!(matches!(
        decide(&bundle, "read.home", json!([stored]), selected, 150),
        CedarEvaluation::Deny { .. }
    ));
    let result = evaluate_entities(
        &bundle,
        "Ops::Operator::\"00000000-0000-4000-8000-000000000002\"",
        "Ops::Action::\"read.home\"",
        CONSOLE,
        entities(json!([grant("read.home", 100, 200)])),
        json!({"now": 150, "grant": grant("read.home", 100, 200)}),
    );
    assert!(!matches!(result, CedarEvaluation::Allow { .. }));
}

#[test]
fn ops_inverted_and_empty_grant_windows_never_allow() {
    let bundle = bundle(POLICY);
    for (from, until) in [(200, 100), (100, 100)] {
        for now in [99, 100, 150, 200, 201] {
            let selected = grant("read.home", from, until);
            assert!(matches!(
                decide(
                    &bundle,
                    "read.home",
                    json!([selected]),
                    selected.clone(),
                    now
                ),
                CedarEvaluation::Deny { .. }
            ));
        }
    }
}

#[test]
fn ops_missing_mistyped_and_unknown_context_facts_fail_closed() {
    let bundle = bundle(POLICY);
    let selected = grant("read.home", 100, 200);
    for context in [
        json!({"now": 150}),
        json!({"grant": selected}),
        json!({"now": "150", "grant": selected}),
        json!({"now": 150, "grant": selected, "undeclared": true}),
    ] {
        let result = evaluate_entities(
            &bundle,
            OPERATOR,
            "Ops::Action::\"read.home\"",
            CONSOLE,
            entities(json!([selected])),
            context,
        );
        assert!(
            matches!(result, CedarEvaluation::Error { .. }),
            "{result:?}"
        );
    }
}

#[test]
fn ops_invalid_entities_and_uids_fail_closed() {
    let bundle = bundle(POLICY);
    let selected = grant("read.home", 100, 200);
    let context = json!({"now": 150, "grant": selected});
    for facts in [
        json!({}),
        json!([{ "uid": {"type": "Ops::Operator", "id": "console-1"}, "attrs": {"grants": "all"}, "parents": [] }]),
    ] {
        assert!(matches!(
            evaluate_entities(
                &bundle,
                OPERATOR,
                "Ops::Action::\"read.home\"",
                CONSOLE,
                facts,
                context.clone()
            ),
            CedarEvaluation::Error { .. }
        ));
    }
    for (principal, action, resource) in [
        ("invalid", "Ops::Action::\"read.home\"", CONSOLE),
        (OPERATOR, "invalid", CONSOLE),
        (OPERATOR, "Ops::Action::\"read.home\"", "invalid"),
        (OPERATOR, "Ops::Action::\"write.home\"", CONSOLE),
    ] {
        assert!(matches!(
            evaluate_entities(
                &bundle,
                principal,
                action,
                resource,
                entities(json!([selected])),
                context.clone()
            ),
            CedarEvaluation::Error { .. }
        ));
    }
}

#[test]
fn ops_entities_schema_rejects_an_unused_undeclared_attribute() {
    let bundle = bundle(POLICY);
    let selected = grant("read.home", 100, 200);
    let mut facts = entities(json!([selected]));
    facts[0]["attrs"]["undeclared"] = json!(true);
    let result = evaluate_entities(
        &bundle,
        OPERATOR,
        "Ops::Action::\"read.home\"",
        CONSOLE,
        facts,
        json!({"now": 150, "grant": selected}),
    );
    assert!(
        matches!(result, CedarEvaluation::Error { .. }),
        "{result:?}"
    );
}

#[test]
fn ops_strict_compilation_rejects_a_mistyped_grant_policy() {
    let invalid = POLICY.replace(
        "context.now < context.grant.until",
        "context.now < \"tomorrow\"",
    );
    assert_ne!(invalid, POLICY);
    assert!(compile_bundle_from_sources(OrgId::one(), 1, "ops-v1", SCHEMA, &invalid).is_err());
}

#[test]
fn ops_evaluation_error_cannot_skip_a_forbid_and_allow() {
    let schema = SCHEMA
        .replace(
            "entity Console;",
            "entity Console; entity Guard = { deny: Bool };",
        )
        .replace(
            "now: Long, grant: Grant",
            "now: Long, grant: Grant, guard: Guard",
        );
    let policy =
        format!("{POLICY}\nforbid(principal, action, resource) when {{ context.guard.deny }};");
    let bundle =
        compile_bundle_from_sources(OrgId::one(), 1, "ops-error-v1", &schema, &policy).unwrap();
    let selected = grant("read.home", 100, 200);
    let result = evaluate_entities(
        &bundle,
        OPERATOR,
        "Ops::Action::\"read.home\"",
        CONSOLE,
        entities(json!([selected])),
        json!({"now": 150, "grant": selected, "guard": {"__entity": {"type": "Ops::Guard", "id": "missing"}}}),
    );
    assert!(
        matches!(result, CedarEvaluation::Error { .. }),
        "{result:?}"
    );
}
