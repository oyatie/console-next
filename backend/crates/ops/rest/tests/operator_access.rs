// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use aws_lc_rs::digest::{SHA256, digest};
use console_ops_rest::operators::{OperatorRegistry, Refusal};
use serde_json::{Value, json};
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
        "email_sha256": hex::encode(digest(&SHA256, b"operator@example.invalid")),
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
        ("/0/email_sha256", json!("a".repeat(63))),
        ("/0/email_sha256", json!("a".repeat(65))),
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

#[test]
fn shift_bound_oncall_grants_allow_active_responder_and_rotate_at_handoff() {
    use console_ops_domain::bundle::validate_oncall_json;

    let person_a = "00000000-0000-4000-8000-000000000001";
    let person_b = "00000000-0000-4000-8000-000000000002";
    let ops_json = json!([
        {
            "person": person_a,
            "email_sha256": hex::encode(digest(&SHA256, b"primary@example.invalid")),
            "grants": [{"action": "read.me", "from": "2026-10-01T00:00:00Z", "until": "2026-12-01T00:00:00Z"}]
        },
        {
            "person": person_b,
            "email_sha256": hex::encode(digest(&SHA256, b"backup@example.invalid")),
            "grants": [{"action": "read.me", "from": "2026-10-01T00:00:00Z", "until": "2026-12-01T00:00:00Z"}]
        }
    ])
    .to_string();
    let registry = OperatorRegistry::from_json(&ops_json).unwrap();
    let oncall = validate_oncall_json(
        &json!({
            "version": 1,
            "mode": "primary-backup",
            "display_status": "Primary and backup active",
            "timezone": "UTC",
            "rotation": {
                "primary_person": person_a,
                "backup_person": person_b,
                "handoff_weekday": "Mon",
                "handoff_hour_local": 9
            },
            "escalation": {
                "ack_timeout_s": 300,
                "repeat_interval_s": 900,
                "out_of_hours_policy": "sev1-symptoms-only",
                "daily_page_budget": 2
            },
            "synthetic_page_test": {
                "enabled": true,
                "schedule": "weekly",
                "weekday": "Wed",
                "hour_utc": 2,
                "max_delivery_lag_s": 120
            }
        })
        .to_string(),
        Some(&[person_a, person_b]),
    )
    .unwrap();

    let t_week1 = OffsetDateTime::parse("2026-10-28T12:00:00Z", &Rfc3339).unwrap();
    let t_week2 = OffsetDateTime::parse("2026-11-04T12:00:00Z", &Rfc3339).unwrap();

    let shift1 = oncall.active_shift(t_week1);
    let active1_email = if shift1.active_person.as_deref() == Some(person_a) {
        "primary@example.invalid"
    } else {
        "backup@example.invalid"
    };
    let inactive1_email = if active1_email == "primary@example.invalid" {
        "backup@example.invalid"
    } else {
        "primary@example.invalid"
    };

    for action in ["alert.ack", "alert.silence", "incident.write"] {
        assert!(
            registry
                .authorize_with_shift(active1_email, action, t_week1, Some(&oncall))
                .is_ok(),
            "{action} should be granted on active shift"
        );
        assert_eq!(
            registry
                .authorize_with_shift(inactive1_email, action, t_week1, Some(&oncall))
                .unwrap_err(),
            Refusal::ActionDenied
        );
        // Next week handoff rotates active responder!
        assert!(
            registry
                .authorize_with_shift(inactive1_email, action, t_week2, Some(&oncall))
                .is_ok(),
            "{action} should rotate to backup responder after handoff"
        );
        assert_eq!(
            registry
                .authorize_with_shift(active1_email, action, t_week2, Some(&oncall))
                .unwrap_err(),
            Refusal::ActionDenied
        );
    }
}
