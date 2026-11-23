// SPDX-License-Identifier: LicenseRef-Proprietary
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use console_ops_application::snapshot::Membership;
use console_ops_application::victoriametrics::{
    QUERY_CONTAINER_INFO, QUERY_CONTAINER_RELEASE_STALE, QUERY_CONTAINER_RUNNING,
    QUERY_CONTAINER_STARTED_TS, QUERY_JOB_LAST_EXIT_CODE, QUERY_JOB_LAST_SUCCESS_TS,
    QUERY_NODE_TEXTFILE_MTIME, QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE,
    QUERY_PGBACKREST_LAST_BACKUP_STOP, QUERY_SLO_ERROR_BUDGET_RATIO,
};
use console_ops_application::{
    Alert, AlertState as RawAlertState, AlertStatus, AlertmanagerSnapshot, AlertmanagerStatus,
    CockpitEvaluator, SourceError, SourcePorts, VersionInfo, VmalertSnapshot,
};
use console_ops_domain::ladders::{Drift, EvidenceState, Health, JobState};
use time::{Duration, macros::datetime};

mod eval_support;
use eval_support::{MockAm, MockVm, MockVmetrics, TestResult, block_on, bundle, sample};

#[test]
fn evaluates_running_declared_extra_jobs_budgets_staleness_and_bans_placeholders() -> TestResult {
    let (comp, settings) = bundle()?;
    let now = datetime!(2026-01-01 00:00 UTC);
    let mut series = BTreeMap::new();
    series.insert(
        QUERY_CONTAINER_RUNNING.to_owned(),
        vec![
            sample(&[("service", "api")], 1.0),
            sample(&[("service", "rogue-worker"), ("project", "extra")], 1.0),
        ],
    );
    series.insert(
        QUERY_CONTAINER_RELEASE_STALE.to_owned(),
        vec![sample(&[("service", "api")], 0.0)],
    );
    series.insert(
        QUERY_CONTAINER_INFO.to_owned(),
        vec![sample(&[("service", "api"), ("image", "console:v1")], 1.0)],
    );
    series.insert(
        QUERY_CONTAINER_STARTED_TS.to_owned(),
        vec![sample(&[("service", "api")], now.unix_timestamp() as f64)],
    );
    series.insert(
        QUERY_JOB_LAST_EXIT_CODE.to_owned(),
        vec![sample(&[("job", "nightly")], 1.0)],
    );
    series.insert(
        QUERY_JOB_LAST_SUCCESS_TS.to_owned(),
        vec![sample(&[("job", "nightly")], now.unix_timestamp() as f64)],
    );
    series.insert(
        QUERY_SLO_ERROR_BUDGET_RATIO.to_owned(),
        vec![sample(&[("slo", "availability")], 0.99)],
    );
    series.insert(
        QUERY_PGBACKREST_ARCHIVE_MAX_WAL_AGE.to_owned(),
        vec![sample(&[("repo", "1")], 120.0)],
    );
    series.insert(
        QUERY_PGBACKREST_LAST_BACKUP_STOP.to_owned(),
        vec![sample(&[("repo", "1")], now.unix_timestamp() as f64)],
    );
    series.insert(
        QUERY_NODE_TEXTFILE_MTIME.to_owned(),
        vec![sample(
            &[("collector", "container")],
            now.unix_timestamp() as f64,
        )],
    );

    let am = Arc::new(MockAm(Mutex::new(Ok(AlertmanagerSnapshot {
        alerts: vec![Alert {
            fingerprint: "fp1".into(),
            labels: [
                ("alertname".into(), "HighLatency".into()),
                ("severity".into(), "page".into()),
            ]
            .into(),
            annotations: [("summary".into(), "No data".into())].into(),
            starts_at: now,
            ends_at: now + Duration::hours(1),
            status: AlertStatus {
                state: RawAlertState::Active,
                silenced_by: vec![],
                inhibited_by: vec![],
            },
        }],
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
    let vmetrics = Arc::new(MockVmetrics(Mutex::new(Ok(series))));

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
    assert_eq!(snap.running.components.len(), 3);
    let api = snap
        .running
        .components
        .iter()
        .find(|c| c.key == "api")
        .ok_or("api")?;
    assert_eq!(api.membership, Membership::Declared);
    assert_eq!(api.health.value(), Some(&Health::Healthy));
    assert_eq!(api.drift.value(), Some(&Drift::Synced));
    let missing = snap
        .running
        .components
        .iter()
        .find(|c| c.key == "missing-svc")
        .ok_or("missing")?;
    assert_eq!(missing.health.value(), Some(&Health::Missing));
    let extra = snap
        .running
        .components
        .iter()
        .find(|c| c.key == "rogue-worker")
        .ok_or("extra")?;
    assert_eq!(extra.membership, Membership::Extra);

    assert_eq!(snap.jobs.jobs[0].state.value(), Some(&JobState::Failed));
    assert_eq!(snap.home.budgets.len(), 1);
    assert_eq!(snap.home.data_safety.len(), 1);
    assert_eq!(
        snap.alerts.groups[0].component.reason(),
        Some("not instrumented")
    );
    assert_eq!(
        snap.alerts.groups[0].summary.reason(),
        Some("not instrumented")
    );
    let detail = snap
        .alert_details
        .get(&snap.alerts.groups[0].key)
        .ok_or("detail")?;
    assert_eq!(detail.impact.reason(), Some("not instrumented"));
    assert_eq!(detail.first_action.reason(), Some("not instrumented"));

    let serialized = serde_json::to_string(&snap.home)?;
    for banned in ["\"No data\"", "\"N/A\"", "\"—\""] {
        assert!(!serialized.contains(banned), "banned placeholder {banned}");
    }

    let home_val = serde_json::to_value(&snap.home)?;
    let since_val = home_val["worklist"][0]["since"]["value"]
        .as_str()
        .ok_or("worklist since.value must be RFC 3339 string")?;
    assert!(since_val.ends_with('Z'), "{since_val}");
    let backup_val = home_val["data_safety"][0]["last_base_backup"]["value"]
        .as_str()
        .ok_or("data_safety last_base_backup.value must be RFC 3339 string")?;
    assert!(backup_val.ends_with('Z'), "{backup_val}");

    let alerts_val = serde_json::to_value(&snap.alerts)?;
    let alert_since = alerts_val["groups"][0]["since"]["value"]
        .as_str()
        .ok_or("alert group since.value must be RFC 3339 string")?;
    assert!(alert_since.ends_with('Z'), "{alert_since}");

    let detail_val = serde_json::to_value(detail)?;
    let member_since = detail_val["members"][0]["since"]["value"]
        .as_str()
        .ok_or("member since.value must be RFC 3339 string")?;
    assert!(member_since.ends_with('Z'), "{member_since}");

    let running_val = serde_json::to_value(&snap.running)?;
    let api_started = running_val["components"]
        .as_array()
        .and_then(|arr| arr.iter().find(|c| c["key"] == "api"))
        .and_then(|c| c["started"]["value"].as_str())
        .ok_or("api started.value must be RFC 3339 string")?;
    assert!(api_started.ends_with('Z'), "{api_started}");

    let jobs_val = serde_json::to_value(&snap.jobs)?;
    let job_last_run = jobs_val["jobs"][0]["last_run"]["value"]
        .as_str()
        .ok_or("job last_run.value must be RFC 3339 string")?;
    assert!(job_last_run.ends_with('Z'), "{job_last_run}");

    let at_boundary = eval.evaluate(now + Duration::seconds(120));
    assert_eq!(at_boundary.alerts.count.state(), EvidenceState::Verified);
    let past_boundary = eval.evaluate(now + Duration::seconds(180));
    assert_eq!(past_boundary.alerts.count.state(), EvidenceState::Unknown);
    assert_eq!(past_boundary.alerts.count.reason(), Some("stale 3m"));
    assert!(past_boundary.alerts.count.value().is_none());

    eval.inject_source_error_for_test(
        "victoriametrics",
        SourceError::Down,
        now + Duration::seconds(181),
    );
    let down = eval.evaluate(now + Duration::seconds(181));
    assert_eq!(down.home.verdict.worst, Health::Unknown);
    assert!(down.running.count.value().is_none());
    Ok(())
}
