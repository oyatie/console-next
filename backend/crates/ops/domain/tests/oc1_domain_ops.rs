// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_domain::UtcTimestamp;
use console_ops_domain::changes::{ReleaseSample, compute_dora5, parse_gate_statement};
use console_ops_domain::incident::{
    IncidentEvent, IncidentRefusal, IncidentState, PersonalDataImpact,
};
use console_ops_domain::ladders::{EvidenceState, Incident, IncidentSeverity};
use console_ops_domain::recovery::DrillRequestInput;
use console_ops_domain::runbook::extract_runbook_anchors;
use console_ops_domain::status::parse_status_v2_json;
use serde_json::json;
use time::{Duration, macros::datetime};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn incident_lifecycle_enforces_clocks_optimistic_lock_and_postmortem_gate() -> TestResult {
    let t0 = datetime!(2026-11-20 00:00 UTC);
    let discovered = t0 - Duration::hours(25);
    let declare = IncidentEvent::Declared {
        title: "API 5xx spike".into(),
        sev: IncidentSeverity::Sev1,
        lead: Some("operator-1".into()),
        affected_components: vec!["api".into()],
        personal_data_impact: PersonalDataImpact::Unknown,
        intrusion: true,
        discovered_at: UtcTimestamp::new(discovered),
        next_public_update_at: Some(UtcTimestamp::new(t0 + Duration::minutes(30))),
        public_incident_id: None,
    };

    let state = IncidentState::evolve(None, "INC-0001", &declare, 1, "h1", t0, "op-1", Some(0))
        .map_err(|e| format!("{e:?}"))?;
    let clocks = state.legal_clocks(t0);
    assert_eq!(clocks.len(), 2);
    assert_eq!(clocks[0].kind, "pipc_kisa_72h");
    assert!(!clocks[0].overdue);
    assert_eq!(clocks[1].kind, "intrusion_24h");
    assert!(clocks[1].overdue);

    assert_eq!(
        IncidentState::evolve(
            Some(&state),
            "INC-0001",
            &IncidentEvent::NoteAdded {
                note: "Checking".into()
            },
            2,
            "h2",
            t0,
            "op-1",
            Some(99),
        ),
        Err(IncidentRefusal::Conflict)
    );

    assert_eq!(
        IncidentState::evolve(
            Some(&state),
            "INC-0001",
            &IncidentEvent::Resolved { summary: None },
            2,
            "h2",
            t0,
            "op-1",
            Some(1),
        ),
        Err(IncidentRefusal::PostmortemRequired)
    );

    let linked = IncidentState::evolve(
        Some(&state),
        "INC-0001",
        &IncidentEvent::PostmortemLinked {
            postmortem_ref: "docs/postmortems/2026-11-20.md".into(),
        },
        2,
        "h2",
        t0,
        "op-1",
        Some(1),
    )
    .map_err(|e| format!("{e:?}"))?;
    let resolved = IncidentState::evolve(
        Some(&linked),
        "INC-0001",
        &IncidentEvent::Resolved {
            summary: Some("Mitigated".into()),
        },
        3,
        "h3",
        t0,
        "op-1",
        Some(2),
    )
    .map_err(|e| format!("{e:?}"))?;
    assert_eq!(resolved.status, Incident::Resolved);

    assert_eq!(
        IncidentState::evolve(
            Some(&resolved),
            "INC-0001",
            &IncidentEvent::NoteAdded {
                note: "Late".into()
            },
            4,
            "h4",
            t0,
            "op-1",
            Some(3),
        ),
        Err(IncidentRefusal::Final)
    );
    Ok(())
}

#[test]
fn gate_statement_and_dora5_and_status_v2_and_drill_validate_inputs() -> TestResult {
    let hex64 = "a".repeat(64);
    let digest = format!("sha256:{hex64}");
    let gates = json!({
        "_type": "https://in-toto.io/Statement/v1",
        "predicateType": "https://cosskorea.com/attestations/console-gates/v1",
        "subject": [{"digest": {"sha256": hex64}}],
        "predicate": {
            "inputs": {"backend": "abc123"},
            "gates": [{"name": "smoke", "result": "pass"}],
            "runner": {"kind": "gha", "url": null},
            "approver": null,
            "bake": "normal"
        }
    });
    assert!(parse_gate_statement(&gates.to_string(), Some(&digest)).is_ok());
    assert!(
        parse_gate_statement(
            &gates.to_string(),
            Some(&format!("sha256:{}", "b".repeat(64)))
        )
        .is_err()
    );

    let now = datetime!(2026-11-20 00:00 UTC);
    let empty_dora = compute_dora5(
        &[],
        "host-state",
        Some(now),
        now,
        NonZeroU64::new(60).ok_or("nonzero")?,
    );
    assert_eq!(empty_dora.n, 0);
    assert_eq!(
        empty_dora.deployment_frequency.state(),
        EvidenceState::Unknown
    );
    assert_eq!(
        empty_dora.deployment_frequency.reason(),
        Some("not instrumented")
    );

    let samples = vec![ReleaseSample {
        digest: digest.clone(),
        released_at: now - Duration::hours(1),
        commit_at: Some(now - Duration::hours(2)),
        restored_at: None,
        failed: false,
        rolled_back: false,
        rework: false,
    }];
    let populated = compute_dora5(
        &samples,
        "host-state",
        Some(now),
        now,
        NonZeroU64::new(60).ok_or("nonzero")?,
    );
    assert_eq!(populated.n, 1);
    assert_eq!(populated.lead_time_s.value(), Some(&3600.0));
    assert_eq!(populated.mttr_s.state(), EvidenceState::Unknown);

    let status_json = json!({
        "schema": 2,
        "rev": 3,
        "generated_at": "2026-11-20T00:00:00Z",
        "record_start": "2026-10-01T00:00:00Z",
        "evidence": {
            "schema": 1,
            "samples": [{
                "at": "2026-11-20T00:00:00Z",
                "components": {"web": "ok", "api": "degraded"}
            }]
        },
        "incidents": [{
            "id": "ST-0001",
            "title": {"ko": "점검", "en": "Check"},
            "started_at": "2026-11-20T00:00:00Z",
            "report_url": null,
            "updates": [{
                "n": 1,
                "at": "2026-11-20T00:00:00Z",
                "text": {"ko": "확인 중", "en": "Investigating"},
                "stage": "investigating",
                "components": {"api": "degraded"},
                "next_update_by": null,
                "correction_of": null
            }]
        }],
        "maintenances": []
    });
    let parsed_status = parse_status_v2_json(&status_json.to_string())?;
    assert_eq!(parsed_status.rev, 3);
    assert_eq!(parsed_status.incidents[0].id, "ST-0001");

    assert!(
        serde_json::from_value::<DrillRequestInput>(json!({
            "repo": "1",
            "drill_type": "name",
            "window": "now",
            "tenant": "forbidden-tenant-pitr"
        }))
        .is_err()
    );

    let bad_time: DrillRequestInput = serde_json::from_value(json!({
        "repo": "1",
        "drill_type": "time",
        "target": "2026-11-20T09:00:00+09:00",
        "window": "now"
    }))?;
    assert!(bad_time.validate().is_err());
    Ok(())
}

#[test]
fn runbook_anchor_extraction_matches_alert_rule_lint_rules() {
    let md = "\
# Main Title
<a id=\"custom-anchor\"></a>
## First Action!
```bash
# Fake Heading Inside Fence
<a id=\"ignored-anchor\"></a>
```
## First Action!
## [Linked `Code`](https://example.invalid) <span>Tag</span>
";
    let anchors = extract_runbook_anchors(md);
    let slugs: Vec<&str> = anchors.iter().map(|a| a.slug.as_str()).collect();
    assert_eq!(
        slugs,
        vec![
            "main-title",
            "custom-anchor",
            "first-action",
            "first-action-1",
            "linked-code-tag"
        ]
    );
}
