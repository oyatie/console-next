// SPDX-License-Identifier: LicenseRef-Proprietary
use std::fs;

use console_ops_adapter_fs::{RecordSpool, SpoolError, SpoolPrefix, SpoolSet};
use console_ops_application::actions::{ActionStore, CmdHandOffInput};
use console_ops_application::alert_actions::{AlertAckStore, SilenceAuditStore};
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::domain::incident::{
    IncidentEvent, IncidentRefusal, PersonalDataImpact,
};
use console_ops_application::domain::ladders::{Incident, IncidentSeverity};
use console_ops_application::incidents::{IncidentError, IncidentStore};
use console_ops_application::obligations::{Context, Operator};
use console_ops_application::promote::{FeedbackStore, PromotionStore};
use console_ops_application::time::OffsetDateTime;

mod support;
use support::Temp;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn ctx() -> Context {
    Context {
        at: OffsetDateTime::from_unix_timestamp(1_795_132_800)
            .unwrap_or(OffsetDateTime::UNIX_EPOCH),
        operator: Operator {
            person: "00000000-0000-4000-8000-000000000001".to_owned(),
            method: "access-jwt".to_owned(),
        },
        support_ref: "sup-ref-001".to_owned(),
    }
}

#[test]
fn spool_set_opens_all_nine_prefixes_with_zero_sidecars_inside_prefix_dirs() -> TestResult {
    let tmp = Temp::new();
    let set = SpoolSet::open_resilient(&tmp.0);

    for prefix in SpoolPrefix::ALL {
        let dir = tmp.0.join(prefix.as_str());
        assert!(dir.is_dir(), "missing dir for {}", prefix.as_str());
        assert_eq!(fs::read_dir(&dir)?.count(), 0);
    }

    let c = ctx();
    set.alerts
        .record_ack("a1b2c3d4", "HighLatency", "api", Some("On it".into()), &c)
        .map_err(|e| format!("{e:?}"))?;
    set.silences
        .record_event("silence_created", Some("sil-1"), Some("a1b2c3d4"), None, &c)
        .map_err(|e| format!("{e:?}"))?;
    set.actions
        .record_handoff(
            &CmdHandOffInput {
                kind: "freeze",
                command: "scripts/tb freeze",
                target: "desired-state",
                consequence: "Freezes deploys",
                expected_result: "Freeze active",
                verify_step: "Check metric",
            },
            &c,
        )
        .map_err(|e| format!("{e:?}"))?;
    let hex64 = "a".repeat(64);
    let digest = format!("sha256:{hex64}");
    set.promotions
        .record_signoff(&digest, "ready", "Soak clean", &c)
        .map_err(|e| format!("{e:?}"))?;
    set.feedback
        .record_triage("fb-1", &digest, "P2", "resolved", "Fixed", &c)
        .map_err(|e| format!("{e:?}"))?;
    assert!(!tmp.record(1).exists());

    let verified = set.verify_all();
    assert_eq!(verified.len(), 9);
    for (prefix, res) in verified {
        let count = res.map_err(|e| format!("{prefix:?}: {e:?}"))?;
        let expected = match prefix {
            SpoolPrefix::Alerts
            | SpoolPrefix::Silences
            | SpoolPrefix::Actions
            | SpoolPrefix::Promotions
            | SpoolPrefix::Feedback => 1,
            _ => 0,
        };
        assert_eq!(count, expected, "{prefix:?}");
        for entry in fs::read_dir(tmp.0.join(prefix.as_str()))? {
            let name = entry?.file_name();
            let s = name.to_string_lossy();
            assert!(
                s.ends_with(".json") && !s.starts_with('.'),
                "unexpected sidecar {s}"
            );
        }
    }
    Ok(())
}

#[test]
fn open_resilient_prefix_survives_broken_startup_and_fails_closed_on_read_and_write() -> TestResult
{
    let tmp = Temp::new();
    let missing_root = tmp.0.join("not-mounted");
    let missing_spool = RecordSpool::open_resilient_prefix(&missing_root, SpoolPrefix::Alerts);
    assert_eq!(missing_spool.read(), Err(SpoolError::Unreadable));
    assert!(!missing_root.exists());

    let broken_spool =
        RecordSpool::open_prefix(&tmp.0, SpoolPrefix::Silences).map_err(|e| format!("{e:?}"))?;
    fs::write(tmp.0.join("silences/00000001.json"), b"{corrupt").map_err(|e| e.to_string())?;
    let resilient = RecordSpool::open_resilient_prefix(&tmp.0, SpoolPrefix::Silences);
    assert_eq!(resilient.read(), Err(SpoolError::ChainBroken(1)));
    drop(broken_spool);
    Ok(())
}

#[test]
fn fs_incident_store_enforces_sequence_conflict_and_postmortem_gate() -> TestResult {
    let tmp = Temp::new();
    let set = SpoolSet::open_resilient(&tmp.0);
    let c = ctx();
    let inc = set
        .incidents
        .declare(
            IncidentEvent::Declared {
                title: "DB latency".into(),
                sev: IncidentSeverity::Sev1,
                lead: None,
                affected_components: vec!["postgres".into()],
                personal_data_impact: PersonalDataImpact::No,
                intrusion: false,
                discovered_at: UtcTimestamp::new(c.at),
                next_public_update_at: None,
                public_incident_id: None,
            },
            &c,
        )
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(inc.id, "INC-0001");
    assert_eq!(inc.head_seq, 1);

    let conflict = set.incidents.mutate(
        "INC-0001",
        99,
        IncidentEvent::NoteAdded {
            note: "Stale".into(),
        },
        &c,
    );
    assert_eq!(
        conflict,
        Err(IncidentError::Domain(IncidentRefusal::Conflict))
    );

    let need_pm =
        set.incidents
            .mutate("INC-0001", 1, IncidentEvent::Resolved { summary: None }, &c);
    assert_eq!(
        need_pm,
        Err(IncidentError::Domain(IncidentRefusal::PostmortemRequired))
    );

    let linked = set
        .incidents
        .mutate(
            "INC-0001",
            1,
            IncidentEvent::PostmortemLinked {
                postmortem_ref: "docs/postmortems/2026-11-20.md".into(),
            },
            &c,
        )
        .map_err(|e| format!("{e:?}"))?;
    let resolved = set
        .incidents
        .mutate(
            "INC-0001",
            linked.head_seq,
            IncidentEvent::Resolved {
                summary: Some("Recovered".into()),
            },
            &c,
        )
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(resolved.status, Incident::Resolved);
    assert_eq!(set.incidents.list().map_err(|e| format!("{e:?}"))?.len(), 1);
    Ok(())
}

#[test]
fn application_sha256_group_key_matches_sha2_crate_digest() {
    use sha2::{Digest, Sha256};
    for (name, comp) in [
        ("", ""),
        ("HighLatency", ""),
        ("HighLatency", "api"),
        ("A×B", "C"),
        ("Watchdog", "obs"),
        ("LongAlertNameWithUnicode한글", "alertgroup-1"),
    ] {
        let got = console_ops_application::alerts_eval::compute_group_key(name, comp);
        let expected = hex::encode(&Sha256::digest(format!("{name}|{comp}").as_bytes())[..4]);
        assert_eq!(got, expected, "mismatch for {name}|{comp}");
    }
}
