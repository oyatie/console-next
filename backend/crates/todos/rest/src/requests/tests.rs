// SPDX-License-Identifier: LicenseRef-Proprietary
//! The bodies the server reads are the ones the contract publishes. The
//! request-body contract check cannot resolve this face's routes table, so
//! these tests hold the schema YAML to the Rust bodies. Limit: an optional
//! Rust field that the YAML never names is not caught.

use std::collections::BTreeSet;

use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::access::{NodeKind, ScopeGrant};
use console_platform_authz::{Feature, Principal, Role};
use console_todos_domain::{REQUEST_LINK_KINDS, RequestLink};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::{ReturnTodoRequest, TodoAskRequest, may_ask};

const ASK: &str = include_str!("../../openapi/schemas/TodoAskRequest.yaml");
const RETURN: &str = include_str!("../../openapi/schemas/ReturnTodoRequest.yaml");
const LINK: &str = include_str!("../../openapi/schemas/TodoRequestLink.yaml");

/// The `- item` lines right under the first line that reads `header`.
fn list<'a>(yaml: &'a str, header: &str) -> Vec<&'a str> {
    let items: Vec<&str> = yaml
        .lines()
        .skip_while(|line| line.trim() != header)
        .skip(1)
        .map_while(|line| line.trim().strip_prefix("- "))
        .collect();
    assert!(!items.is_empty(), "no {header} list in\n{yaml}");
    items
}

/// The keys directly under the top-level `properties:`.
fn properties(yaml: &str) -> Vec<&str> {
    let keys: Vec<&str> = yaml
        .lines()
        .skip_while(|line| *line != "properties:")
        .skip(1)
        .take_while(|line| line.is_empty() || line.starts_with(' '))
        .filter_map(|line| line.strip_prefix("  ")?.strip_suffix(':'))
        .filter(|key| !key.starts_with(' '))
        .collect();
    assert!(!keys.is_empty(), "no properties in\n{yaml}");
    keys
}

/// A value the contract allows for `property`.
fn valid(property: &str) -> Value {
    let id = json!("00000000-0000-4000-8000-000000000001");
    match property {
        "assignee_account_id" | "id" => id,
        "due_on" => json!("2026-11-20"),
        "kind" => json!(REQUEST_LINK_KINDS[0]),
        "links" => json!([{ "kind": REQUEST_LINK_KINDS[0], "id": id }]),
        _ => json!("x"),
    }
}

/// `T` reads every property the YAML publishes, and needs exactly the ones
/// the YAML lists as required.
fn holds<T: DeserializeOwned>(yaml: &str) {
    let required = list(yaml, "required:");
    let full: Map<String, Value> = properties(yaml)
        .into_iter()
        .map(|property| (property.to_owned(), valid(property)))
        .collect();
    let reads = |body: Map<String, Value>| serde_json::from_value::<T>(Value::Object(body)).is_ok();
    assert!(
        required.iter().all(|name| full.contains_key(*name)),
        "{required:?} names a property the schema does not publish"
    );
    assert!(
        reads(full.clone()),
        "a body of every published property is refused: {full:?}"
    );
    for property in full.keys() {
        let mut without = full.clone();
        without.remove(property);
        assert_eq!(
            !reads(without),
            required.contains(&property.as_str()),
            "{property}: the server needs it exactly when the contract requires it"
        );
        let mut mistyped = full.clone();
        mistyped.insert(property.clone(), json!({}));
        assert!(
            !reads(mistyped),
            "{property}: published, but the server never reads it"
        );
    }
}

#[test]
fn the_ask_body_is_the_published_one() {
    holds::<TodoAskRequest>(ASK);
}

#[test]
fn the_return_body_is_the_published_one() {
    holds::<ReturnTodoRequest>(RETURN);
}

#[test]
fn a_link_is_the_published_one_and_its_kinds_are_the_servers() {
    holds::<RequestLink>(LINK);
    assert_eq!(list(LINK, "enum:"), REQUEST_LINK_KINDS);
}

fn principal(roles: &[Role]) -> Principal {
    Principal::new(
        UserId::new(),
        OrgId::new(),
        roles.iter().copied().collect::<BTreeSet<_>>(),
        BranchScope::All,
    )
}

fn in_support(mut principal: Principal) -> Principal {
    principal.support = Some(
        serde_json::from_value(json!({
            "active": true, "org_id": principal.org_id.as_uuid(), "operator_approved": true,
            "tenant_approved": true, "session_id": "00000000-0000-4000-8000-000000000009",
            "operator_label": "operator", "scope": ["org", "hr_basic"], "reveal_classes": [],
        }))
        .unwrap(),
    );
    principal
}

#[test]
fn asking_needs_a_request_grant_or_the_ops_account_and_never_a_support_session() {
    let ops = principal(&[]).with_tenant_ops(true);
    assert!(may_ask(&ops), "the ops account asks with no grant");
    for titles in [&[Role::SuperAdmin][..], &[Role::Admin]] {
        assert!(
            !may_ask(&principal(titles)),
            "{titles:?} is a title, not a grant"
        );
    }
    let holder = principal(&[]).with_scope_grants(vec![ScopeGrant {
        feature: Feature::TodoAssign,
        kind: NodeKind::Department,
        id: *UserId::new().as_uuid(),
    }]);
    let hr = principal(&[]).with_scope_grants(vec![ScopeGrant {
        feature: Feature::EmployeeDirectoryManage,
        kind: NodeKind::Tenant,
        id: *UserId::new().as_uuid(),
    }]);
    assert!(may_ask(&holder));
    assert!(!may_ask(&hr), "another key's grant is not a request grant");
    assert!(!may_ask(&in_support(holder)));
    assert!(!may_ask(&in_support(ops)));
}
