// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::{Arc, Mutex};

use console_ops_application::events::{DeltaRingBuffer, OpsEvent, ReplayOutcome};
use console_ops_application::victoriametrics::QUERY_CONTAINER_RUNNING;
use console_ops_application::vmalert::{
    Rule, RuleAlert, RuleAlertState, RuleHealth, RuleKind, RuleState,
};
use console_ops_application::{
    AlertmanagerSnapshot, AlertmanagerStatus, CockpitEvaluator, SourcePorts, VersionInfo,
    VmalertSnapshot,
};
use console_ops_domain::ladders::{EvidenceState, Health};
use time::macros::datetime;

mod eval_support;
use eval_support::{MockAm, MockVm, MockVmetrics, TestResult, block_on, bundle, sample};

#[test]
fn alertmanager_empty_while_vmalert_firing_cannot_report_all_quiet() -> TestResult {
    let (comp, settings) = bundle()?;
    let now = datetime!(2026-01-01 00:00 UTC);
    let am = Arc::new(MockAm(Mutex::new(Ok(AlertmanagerSnapshot {
        alerts: vec![],
        silences: vec![],
        status: AlertmanagerStatus {
            version_info: VersionInfo {
                version: "0.27".into(),
            },
            uptime: now,
        },
    }))));
    let vm = Arc::new(MockVm(Mutex::new(Ok(VmalertSnapshot {
        groups: vec![],
        alerts: vec![RuleAlert {
            labels: [("alertname".into(), "SyntheticAlert".into())].into(),
            annotations: None,
            state: RuleAlertState::Firing,
            active_at: now,
            value: "1".into(),
            rule_id: "1".into(),
            group_id: "1".into(),
            expression: "up == 0".into(),
        }],
    }))));
    let vmetrics = Arc::new(MockVmetrics(Mutex::new(Ok(BTreeMap::from([(
        QUERY_CONTAINER_RUNNING.to_owned(),
        vec![
            sample(&[("service", "api")], 1.0),
            sample(&[("service", "missing-svc")], 1.0),
        ],
    )])))));
    let mut eval = CockpitEvaluator::new(
        SourcePorts {
            alertmanager: am,
            vmalert: vm,
            victoriametrics: vmetrics,
        },
        comp,
        settings,
        now,
    );
    eval.set_access_jwks_status(Some(now), None);
    block_on(eval.tick(now));
    let snap = eval.evaluate(now);
    assert_eq!(snap.home.verdict.worst, Health::Unknown);
    assert!(!snap.home.verdict.text.contains("All quiet"));
    assert!(
        snap.home
            .verdict
            .text
            .contains("alertmanager empty while vmalert firing")
    );
    assert_eq!(snap.alerts.count.state(), EvidenceState::Unknown);
    let _unused = (
        RuleKind::Alerting,
        RuleState::Firing,
        RuleHealth::Ok,
        Rule {
            id: "1".into(),
            name: "n".into(),
            query: "q".into(),
            kind: RuleKind::Alerting,
            state: RuleState::Firing,
            health: RuleHealth::Ok,
            last_error: String::new(),
            last_evaluation: now,
            labels: BTreeMap::new(),
        },
    );
    Ok(())
}

#[test]
fn delta_ring_buffer_assigns_monotonic_ids_and_emits_resync_when_evicted() -> TestResult {
    let now = datetime!(2026-01-01 00:00 UTC);
    let mut ring = DeltaRingBuffer::new(2);
    let e1 = ring.push(OpsEvent::Heartbeat {
        id: 0,
        evaluated_at: now,
    });
    let e2 = ring.push(OpsEvent::Heartbeat {
        id: 0,
        evaluated_at: now,
    });
    let e3 = ring.push(OpsEvent::Heartbeat {
        id: 0,
        evaluated_at: now,
    });
    assert_eq!((e1.id(), e2.id(), e3.id()), (1, 2, 3));

    assert!(matches!(ring.replay_since(Some(0)), ReplayOutcome::Resync));
    match ring.replay_since(Some(1)) {
        ReplayOutcome::Events(evs) => {
            assert_eq!(evs.iter().map(OpsEvent::id).collect::<Vec<_>>(), vec![2, 3]);
        }
        other => return Err(format!("expected Events, got {other:?}").into()),
    }
    assert!(matches!(ring.replay_since(Some(99)), ReplayOutcome::Resync));
    let _ = NonZeroU64::MIN;
    Ok(())
}
