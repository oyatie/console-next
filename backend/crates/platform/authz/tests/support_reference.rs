// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_platform_authz::cedar_pbac::actions::{
    ActionBundle, Fact,
    support_reference::{ACTION, POLICIES, SCHEMA},
};

#[test]
fn tenant_configured_grant_does_not_require_an_invented_support_role() {
    let bundle = ActionBundle::compile(ACTION, SCHEMA, POLICIES).unwrap();
    assert_eq!(
        bundle.decide(
            "operator",
            "a",
            &[],
            "a",
            &[("has_support_grant", Fact::Bool(true))]
        ),
        Ok(true)
    );
}
#[test]
fn removing_cross_tenant_forbid_changes_the_decision() {
    let policies = without_policy("support_reference_cross_tenant_denied");
    let bundle = ActionBundle::compile(ACTION, SCHEMA, &policies).unwrap();
    assert_eq!(
        bundle.decide(
            "operator",
            "b",
            &[],
            "a",
            &[("has_support_grant", Fact::Bool(true))]
        ),
        Ok(true)
    );
}
#[test]
fn removing_grant_forbid_changes_the_decision() {
    let policies = without_policy("support_reference_grant_required");
    let bundle = ActionBundle::compile(ACTION, SCHEMA, &policies).unwrap();
    assert_eq!(
        bundle.decide(
            "operator",
            "a",
            &[],
            "a",
            &[("has_support_grant", Fact::Bool(false))]
        ),
        Ok(true)
    );
}

fn without_policy(reason: &str) -> String {
    let marker = format!("@reason(\"{reason}\")");
    let (before, rest) = POLICIES.split_once(&marker).unwrap();
    let (_, after) = rest.split_once("};").unwrap();
    format!("{before}{after}")
}
