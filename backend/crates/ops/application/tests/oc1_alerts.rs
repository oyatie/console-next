// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::{Arc, Mutex};

use console_ops_application::alert_actions::{
    AlertAckRecord, AlertActionsService, SilenceAuditStore, overlay_acks_and_changes,
};
use console_ops_application::alerts_eval::compute_group_key;
use console_ops_application::domain::Observed;
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::domain::alert_actions::{SilenceCreateInput, SilenceMatcherInput};
use console_ops_application::domain::ladders::{AlertState, Severity};
use console_ops_application::obligations::{Context, Operator};
use console_ops_application::snapshot::{
    AlertGroupDetailView, AlertGroupView, AlertGroupsView, ChangeView, RuleView,
    ValueVsThresholdView,
};
use console_ops_application::{
    Alert, AlertState as RawAlertState, AlertStatus, AlertmanagerSnapshot, AlertmanagerStatus,
    CockpitEvaluator, SourceError, SourcePorts, VersionInfo, VmalertSnapshot,
};
use time::{Duration, macros::datetime};

mod eval_support;
use eval_support::{
    MemAckStore, MemSilenceStore, MockAm, MockVm, MockVmetrics, MockWriter, block_on, bundle,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn group_key_matches_console_infra_sha256_and_ack_overlay_sets_lead_and_2h_changes() -> TestResult {
    let key = compute_group_key("HighLatency", "");
    assert_eq!(key.len(), 8);
    assert!(key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));

    let now = datetime!(2026-11-20 02:00 UTC);
    let interval = NonZeroU64::new(60).ok_or("nonzero")?;
    let group = AlertGroupView {
        key: key.clone(),
        alertname: "HighLatency".into(),
        component: Observed::current("api".into(), None, "am".into(), now, now, interval),
        severity: Observed::current(Severity::Page, None, "am".into(), now, now, interval),
        state: Observed::current(AlertState::Firing, None, "am".into(), now, now, interval),
        since: Observed::current(
            UtcTimestamp::new(now),
            None,
            "am".into(),
            now,
            now,
            interval,
        ),
        members_n: Observed::current(1, None, "am".into(), now, now, interval),
        summary: Observed::current("Slow".into(), None, "am".into(), now, now, interval),
        value_vs_threshold: ValueVsThresholdView {
            value: Observed::unknown("vm".into(), "none".into()),
            threshold: Observed::unknown("vm".into(), "none".into()),
            operator: Observed::unknown("vm".into(), "none".into()),
        },
        lead: None,
    };
    let mut groups = AlertGroupsView {
        evaluated_at: now,
        groups: vec![group.clone()],
        count: Observed::current(1, None, "am".into(), now, now, interval),
        alert_count: Observed::current(1, None, "am".into(), now, now, interval),
    };
    let mut details = BTreeMap::from([(
        key.clone(),
        AlertGroupDetailView {
            summary_group: group,
            impact: Observed::unknown("am".into(), "none".into()),
            probable_cause: Observed::unknown("am".into(), "none".into()),
            first_action: Observed::unknown("am".into(), "none".into()),
            notices: vec![],
            rule: RuleView {
                expression: Observed::unknown("vm".into(), "none".into()),
                current_value: Observed::unknown("vm".into(), "none".into()),
            },
            members: vec![],
            changes: vec![],
            links: vec![],
            footer_key: key.clone(),
        },
    )]);
    let acks = vec![AlertAckRecord {
        seq: 1,
        hash: "h".into(),
        support_ref: "s1".into(),
        at: UtcTimestamp::new(now - Duration::minutes(5)),
        operator: "op-first".into(),
        group_key: key.clone(),
        alertname: "HighLatency".into(),
        component: "api".into(),
        note: None,
    }];
    let changes = vec![
        ChangeView {
            at: Observed::current(
                UtcTimestamp::new(now - Duration::minutes(30)),
                None,
                "vm".into(),
                now,
                now,
                interval,
            ),
            summary: Observed::current(
                "Recent deploy".into(),
                None,
                "vm".into(),
                now,
                now,
                interval,
            ),
        },
        ChangeView {
            at: Observed::current(
                UtcTimestamp::new(now - Duration::hours(3)),
                None,
                "vm".into(),
                now,
                now,
                interval,
            ),
            summary: Observed::current("Old deploy".into(), None, "vm".into(), now, now, interval),
        },
    ];
    overlay_acks_and_changes(&mut groups, &mut details, &acks, &changes, now, interval);
    assert_eq!(groups.groups[0].state.value(), Some(&AlertState::Acked));
    assert_eq!(
        groups.groups[0]
            .lead
            .as_ref()
            .and_then(|l| l.value())
            .map(String::as_str),
        Some("op-first")
    );
    assert_eq!(details[&key].changes.len(), 1);
    Ok(())
}

#[test]
fn silence_writes_spool_first_and_records_outcome_on_am_failure() -> TestResult {
    let ack_store = MemAckStore(Mutex::new(vec![]));
    let silence_store = MemSilenceStore(Mutex::new(vec![]));
    let writer = MockWriter { fail: true };
    let svc = AlertActionsService {
        ack_store: &ack_store,
        silence_store: &silence_store,
        am_writer: &writer,
    };
    let now = datetime!(2026-11-20 00:00 UTC);
    let ctx = Context {
        at: now,
        operator: Operator {
            person: "op-1".into(),
            method: "access-jwt".into(),
        },
        support_ref: "sup-1".into(),
    };
    let groups = AlertGroupsView {
        evaluated_at: now,
        groups: vec![],
        count: Observed::unknown("am".into(), "none".into()),
        alert_count: Observed::unknown("am".into(), "none".into()),
    };
    let input = SilenceCreateInput {
        matchers: vec![SilenceMatcherInput {
            name: "alertname".into(),
            value: "HighLatency".into(),
            is_regex: false,
            is_equal: true,
        }],
        ends_at: "2026-11-20T01:00:00Z".into(),
        comment: "Valid reason >= 10 chars".into(),
        group_key: None,
    };
    let mut boxed = Box::pin(svc.create_silence(&input, &groups, &ctx));
    let waker = std::task::Waker::noop();
    let mut cx = std::task::Context::from_waker(waker);
    let res = match boxed.as_mut().poll(&mut cx) {
        std::task::Poll::Ready(r) => r,
        std::task::Poll::Pending => return Err("unexpected pending".into()),
    };
    assert!(res.is_err());
    let records = silence_store.list_records().map_err(|e| format!("{e:?}"))?;
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].action, "silence_requested");
    assert_eq!(records[1].action, "silence_failed");
    Ok(())
}

#[test]
fn evaluator_tick_retains_colliding_alert_groups_across_alertmanager_outage() -> TestResult {
    assert_eq!(
        compute_group_key("Alert12553", "api"),
        compute_group_key("Alert32335", "api")
    );
    let (comp, settings) = bundle()?;
    let now = datetime!(2026-11-20 00:00 UTC);
    let mk = |fp: &str, name: &str| Alert {
        fingerprint: fp.into(),
        labels: [
            ("alertname".into(), name.into()),
            ("severity".into(), "page".into()),
            ("component".into(), "api".into()),
        ]
        .into(),
        annotations: [("summary".into(), format!("{name} firing"))].into(),
        starts_at: now - Duration::minutes(5),
        ends_at: now + Duration::hours(1),
        status: AlertStatus {
            state: RawAlertState::Active,
            silenced_by: vec![],
            inhibited_by: vec![],
        },
    };
    let am = Arc::new(MockAm(Mutex::new(Ok(AlertmanagerSnapshot {
        alerts: vec![mk("fp-1", "Alert12553"), mk("fp-2", "Alert32335")],
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
        alerts: vec![],
    }))));
    let vmetrics = Arc::new(MockVmetrics(Mutex::new(Ok(BTreeMap::new()))));
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
    block_on(eval.tick(now));
    assert_eq!(eval.evaluate(now).alerts.groups.len(), 2);

    let outage_at = now + Duration::seconds(20);
    eval.inject_source_error_for_test("alertmanager", SourceError::Down, outage_at);
    let degraded = eval.evaluate(outage_at);
    assert_eq!(degraded.alerts.groups.len(), 2);
    Ok(())
}
