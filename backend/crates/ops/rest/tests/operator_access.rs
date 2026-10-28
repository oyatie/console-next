// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_ops_rest::operators::{OperatorRegistry, Refusal};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const PERSON: &str = "00000000-0000-4000-8000-000000000001";

#[test]
fn refusal_codes_match_the_ops_contract() {
    for (refusal, code) in [
        (Refusal::NotOperator, "OPS_NOT_OPERATOR"),
        (Refusal::GrantNotLive, "OPS_GRANT_NOT_LIVE"),
        (Refusal::ActionDenied, "OPS_ACTION_DENIED"),
    ] {
        assert_eq!(serde_json::to_value(refusal).unwrap(), code);
    }
}

fn registry(grants: Value) -> String {
    json!([{
        "person": PERSON,
        "email_sha256": hex::encode(Sha256::digest(b"operator@example.invalid")),
        "grants": grants
    }])
    .to_string()
}

fn grant(action: &str, from: &str, until: &str) -> Value {
    json!({"action": action, "from": from, "until": until})
}

fn now() -> OffsetDateTime {
    OffsetDateTime::parse("2026-10-28T00:00:00Z", &Rfc3339).unwrap()
}

fn live(action: &str) -> Value {
    grant(action, "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z")
}

#[test]
fn resolves_only_the_hash_of_the_lowercased_verified_email() {
    let source = registry(json!([live("read.me")]));
    assert!(!source.contains("operator@example.invalid"));
    let access = OperatorRegistry::from_json(&source).unwrap();
    let operator = access
        .authorize("Operator@EXAMPLE.invalid", "read.me", now())
        .unwrap();
    assert_eq!(operator.person.to_string(), PERSON);
    assert_eq!(
        access
            .authorize("other@example.invalid", "read.me", now())
            .unwrap_err(),
        Refusal::NotOperator
    );
}

#[test]
fn cedar_checks_an_expired_grant_and_a_live_grant_in_either_order() {
    let expired = grant("read.home", "2026-10-27T00:00:00Z", "2026-10-28T00:00:00Z");
    for grants in [
        json!([expired, live("read.home")]),
        json!([live("read.home"), expired]),
    ] {
        let access = OperatorRegistry::from_json(&registry(grants)).unwrap();
        assert!(
            access
                .authorize("operator@example.invalid", "read.home", now())
                .is_ok()
        );
        assert_eq!(
            access
                .authorize("operator@example.invalid", "read.sources", now())
                .unwrap_err(),
            Refusal::ActionDenied
        );
    }
}

#[test]
fn no_live_grant_is_a_distinct_refusal() {
    for grants in [
        json!([]),
        json!([grant(
            "read.home",
            "2026-10-27T00:00:00Z",
            "2026-10-28T00:00:00Z"
        )]),
        json!([grant(
            "read.home",
            "2026-10-29T00:00:00Z",
            "2026-10-30T00:00:00Z"
        )]),
    ] {
        let access = OperatorRegistry::from_json(&registry(grants)).unwrap();
        assert_eq!(
            access
                .authorize("operator@example.invalid", "read.home", now())
                .unwrap_err(),
            Refusal::GrantNotLive
        );
    }
}

#[test]
fn fractional_grant_boundaries_keep_their_precision() {
    let from = "2026-10-28T00:00:00.000000001Z";
    let until = "2026-10-28T00:00:00.000000002Z";
    let access =
        OperatorRegistry::from_json(&registry(json!([grant("read.home", from, until)]))).unwrap();
    assert_eq!(
        access
            .authorize("operator@example.invalid", "read.home", now())
            .unwrap_err(),
        Refusal::GrantNotLive
    );
    assert!(
        access
            .authorize(
                "operator@example.invalid",
                "read.home",
                OffsetDateTime::parse(from, &Rfc3339).unwrap()
            )
            .is_ok()
    );
    assert_eq!(
        access
            .authorize(
                "operator@example.invalid",
                "read.home",
                OffsetDateTime::parse(until, &Rfc3339).unwrap()
            )
            .unwrap_err(),
        Refusal::GrantNotLive
    );
}

#[test]
fn every_read_action_is_decided_by_cedar() {
    for action in [
        "read.me",
        "read.home",
        "read.alerts",
        "read.running",
        "read.sources",
    ] {
        let access = OperatorRegistry::from_json(&registry(json!([live(action)]))).unwrap();
        assert!(
            access
                .authorize("operator@example.invalid", action, now())
                .is_ok()
        );
        assert_eq!(
            access
                .authorize("operator@example.invalid", "write.home", now())
                .unwrap_err(),
            Refusal::ActionDenied
        );
    }
}

#[test]
fn registry_refuses_ambiguous_identity_and_invalid_facts() {
    let source = registry(json!([live("read.home")]));
    let valid: Value = serde_json::from_str(&source).unwrap();
    for (pointer, replacement) in [
        ("/0/person", json!("not-a-uuid")),
        ("/0/email_sha256", json!("operator@example.invalid")),
        ("/0/email_sha256", json!("G".repeat(64))),
        ("/0/email_sha256", json!("A".repeat(64))),
        ("/0/grants/0/from", json!("2026-10-28T00:00:00+00:00")),
        ("/0/grants/0/until", json!("invalid")),
        ("/0/grants/0/action", json!("write.home")),
    ] {
        let mut invalid = valid.clone();
        *invalid.pointer_mut(pointer).unwrap() = replacement;
        assert!(
            OperatorRegistry::from_json(&invalid.to_string()).is_err(),
            "{pointer}"
        );
    }
    assert!(OperatorRegistry::from_json(&json!([valid[0], valid[0]]).to_string()).is_err());
    let mut duplicate_person = valid[0].clone();
    duplicate_person["email_sha256"] = json!("0".repeat(64));
    assert!(OperatorRegistry::from_json(&json!([valid[0], duplicate_person]).to_string()).is_err());
    let mut duplicate_email = valid[0].clone();
    duplicate_email["person"] = json!("00000000-0000-4000-8000-000000000002");
    assert!(OperatorRegistry::from_json(&json!([valid[0], duplicate_email]).to_string()).is_err());
    let mut unknown_grant = valid.clone();
    unknown_grant[0]["grants"][0]["scope"] = json!("all");
    assert!(OperatorRegistry::from_json(&unknown_grant.to_string()).is_err());
    let mut unknown = valid;
    unknown[0]["role"] = json!("admin");
    assert!(OperatorRegistry::from_json(&unknown.to_string()).is_err());
}
