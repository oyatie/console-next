// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::WorkKind;
use console_ops_domain::alert_actions::{
    AlertAckPayload, SilenceCreateInput, SilenceMatcherInput, SilenceValidationError,
    validate_alert_ack_note, validate_silence_create,
};
use console_ops_domain::bundle::{validate_oncall_json, validate_ops_settings_json};
use console_ops_domain::ladders::Severity;
use console_ops_domain::obligation::{Event, Obligation, State};
use proptest::prelude::*;
use serde_json::json;
use time::{Duration, macros::datetime};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn base_settings() -> serde_json::Value {
    let src = json!({
        "url": "http://example.invalid",
        "producer": "fixture",
        "interval_s": 15,
        "read_limits": {"request_timeout_ms": 5000, "max_response_bytes": 4096}
    });
    json!({
        "sources": {"alertmanager": src, "vmalert": src, "victoriametrics": src},
        "access": {
            "team": "cosskorea",
            "aud": "ops-aud",
            "issuer": "https://example.cloudflareaccess.com",
            "jwks": "/etc/console/ops/access-jwks.json",
            "interval_s": 3600
        },
        "origin": "https://ops.cosskorea.com",
        "thresholds": {},
        "budgets": {"evaluate_interval_s": 15}
    })
}

fn base_oncall() -> serde_json::Value {
    json!({
        "version": 1,
        "mode": "single-operator",
        "display_status": "Single operator on call",
        "timezone": "Asia/Seoul",
        "rotation": {
            "primary_person": null,
            "backup_person": null,
            "handoff_weekday": "Mon",
            "handoff_hour_local": 9
        },
        "escalation": {
            "ack_timeout_s": 900,
            "repeat_interval_s": 43200,
            "out_of_hours_policy": "sev1-symptoms-only",
            "daily_page_budget": 2
        },
        "synthetic_page_test": {
            "enabled": true,
            "schedule": "weekly",
            "weekday": "Mon",
            "hour_utc": 0,
            "max_delivery_lag_s": 120
        }
    })
}

#[test]
fn obligation_getters_state_deserialize_and_worklist_key_work() -> TestResult {
    let state: State = serde_json::from_value(json!("in-review"))?;
    assert_eq!(state, State::InReview);
    assert_eq!(serde_json::to_value(WorkKind::Obligation)?, "obligation");

    let ev: Event = serde_json::from_value(json!({
        "event": "opened",
        "fields": {
            "kind": "launch-gate",
            "reviewer_role": "owner",
            "title": "Synthetic gate",
            "due": "2026-11-22",
            "evidence_ref": "ref-1"
        }
    }))?;
    let ob = Obligation::evolve(None, &ev).map_err(|e| format!("{e:?}"))?;
    assert_eq!(ob.title(), "Synthetic gate");
    assert_eq!(ob.evidence_ref(), Some("ref-1"));
    assert!(ob.due().is_some());
    assert!(ob.signer().is_none());
    assert!(ob.signed_on().is_none());

    let now = datetime!(2026-11-20 00:00 UTC);
    assert_eq!(ob.days_remaining(now), Some(2));
    assert!(ob.worklist_key(now, 7).is_some());
    Ok(())
}

#[test]
fn ops_settings_preserves_stage0_and_validates_optional_records_and_obligations() -> TestResult {
    let stage0 = validate_ops_settings_json(&base_settings().to_string())?;
    assert!(stage0.records.is_none());
    assert!(stage0.obligations.is_none());
    assert_eq!(stage0.due_soon_days(), 7);

    let mut with_opts = base_settings();
    with_opts["records"] = json!({"dir": "/srv/console/ops-records"});
    with_opts["obligations"] = json!({"due_soon_days": 14});
    let parsed = validate_ops_settings_json(&with_opts.to_string())?;
    assert_eq!(
        parsed.records.as_ref().map(|r| r.dir.as_str()),
        Some("/srv/console/ops-records")
    );
    assert_eq!(parsed.due_soon_days(), 14);

    for bad_patch in [
        ("records", json!({"dir": "relative/path"})),
        ("records", json!({"dir": "//double/slash"})),
        ("records", json!({"dir": "/srv/ops\n"})),
        ("obligations", json!({"due_soon_days": 0})),
        ("unknown_key", json!(true)),
    ] {
        let mut bad = base_settings();
        bad[bad_patch.0] = bad_patch.1;
        assert!(validate_ops_settings_json(&bad.to_string()).is_err());
    }
    Ok(())
}

#[test]
fn oncall_validation_matches_config_bundle_rules() -> TestResult {
    let valid = validate_oncall_json(&base_oncall().to_string(), None)?;
    assert_eq!(valid.version, 1);

    let uuid1 = "00000000-0000-4000-8000-000000000001";
    let uuid2 = "00000000-0000-4000-8000-000000000002";
    let mut pb = base_oncall();
    pb["mode"] = json!("primary-backup");
    pb["display_status"] = json!("Primary and backup active");
    pb["rotation"]["primary_person"] = json!(uuid1);
    pb["rotation"]["backup_person"] = json!(uuid2);
    assert!(validate_oncall_json(&pb.to_string(), Some(&[uuid1, uuid2])).is_ok());
    assert!(validate_oncall_json(&pb.to_string(), Some(&[uuid1])).is_err());

    let with_at = base_oncall()
        .to_string()
        .replace("Asia/Seoul", "ops@example");
    assert!(validate_oncall_json(&with_at, None).is_err());

    let mut bad_single = base_oncall();
    bad_single["rotation"]["backup_person"] = json!(uuid1);
    assert!(validate_oncall_json(&bad_single.to_string(), Some(&[uuid1])).is_err());

    let mut bad_budget = base_oncall();
    bad_budget["escalation"]["daily_page_budget"] = json!(3);
    assert!(validate_oncall_json(&bad_budget.to_string(), None).is_err());
    Ok(())
}

#[test]
fn silence_and_ack_validation_enforces_exact_matchers_watchdog_and_ttl() -> TestResult {
    assert!(serde_json::from_value::<AlertAckPayload>(json!({"note": "Investigating"})).is_ok());
    assert!(validate_alert_ack_note(Some("No data")).is_err());
    assert!(validate_alert_ack_note(Some("   ")).is_ok());

    let now = datetime!(2026-11-20 00:00 UTC);
    let ok_input = SilenceCreateInput {
        matchers: vec![
            SilenceMatcherInput {
                name: "alertname".into(),
                value: "HighLatency".into(),
                is_regex: false,
                is_equal: true,
            },
            SilenceMatcherInput {
                name: "component".into(),
                value: "api".into(),
                is_regex: false,
                is_equal: true,
            },
        ],
        ends_at: "2026-11-20T03:00:00Z".into(),
        comment: "Investigating spike during maintenance".into(),
        group_key: None,
    };
    assert!(validate_silence_create(&ok_input, Some(Severity::Page), now).is_ok());

    let mut watchdog = ok_input.clone();
    watchdog.matchers[0].value = "Watchdog".into();
    assert_eq!(
        validate_silence_create(&watchdog, Some(Severity::Page), now),
        Err(SilenceValidationError::WatchdogUnsilenceable)
    );

    let mut no_alertname = ok_input.clone();
    no_alertname.matchers.remove(0);
    assert_eq!(
        validate_silence_create(&no_alertname, Some(Severity::Page), now),
        Err(SilenceValidationError::WatchdogUnsilenceable)
    );

    let mut regex_m = ok_input.clone();
    regex_m.matchers[0].is_regex = true;
    assert!(matches!(
        validate_silence_create(&regex_m, Some(Severity::Page), now),
        Err(SilenceValidationError::Invalid(_))
    ));

    let mut short_comment = ok_input.clone();
    short_comment.comment = "too short".into();
    assert!(matches!(
        validate_silence_create(&short_comment, Some(Severity::Page), now),
        Err(SilenceValidationError::Invalid(_))
    ));

    let mut page_too_long = ok_input.clone();
    page_too_long.ends_at = "2026-11-20T05:00:00Z".into();
    assert!(matches!(
        validate_silence_create(&page_too_long, Some(Severity::Page), now),
        Err(SilenceValidationError::TtlExceeded(_))
    ));
    assert!(validate_silence_create(&page_too_long, Some(Severity::Ticket), now).is_ok());

    let mut ticket_too_long = ok_input;
    ticket_too_long.ends_at = "2026-11-24T00:00:00Z".into();
    assert!(matches!(
        validate_silence_create(&ticket_too_long, Some(Severity::Ticket), now),
        Err(SilenceValidationError::TtlExceeded(_))
    ));
    Ok(())
}

proptest! {
    #[test]
    fn silence_ttl_boundary_holds_for_any_positive_seconds(secs in 1i64..400_000) {
        let now = datetime!(2026-11-20 00:00 UTC);
        let ends = (now + Duration::seconds(secs))
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|e| TestCaseError::fail(e.to_string()))?;
        let input = SilenceCreateInput {
            matchers: vec![SilenceMatcherInput {
                name: "alertname".into(),
                value: "TestAlert".into(),
                is_regex: false,
                is_equal: true,
            }],
            ends_at: ends,
            comment: "Valid silence reason >= 10".into(),
            group_key: None,
        };
        let page = validate_silence_create(&input, Some(Severity::Page), now);
        prop_assert_eq!(page.is_ok(), secs <= 4 * 3600);
        let ticket = validate_silence_create(&input, Some(Severity::Ticket), now);
        prop_assert_eq!(ticket.is_ok(), secs <= 72 * 3600);
    }
}
