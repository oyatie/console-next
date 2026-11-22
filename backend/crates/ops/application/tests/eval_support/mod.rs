// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code)]
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Mutex;
use std::task::{Context, Poll, Waker};

use console_ops_application::alert_actions::{
    AlertAckRecord, AlertAckStore, AlertmanagerSilencePost, AlertmanagerWriter, SilenceAuditRecord,
    SilenceAuditStore,
};
use console_ops_application::domain::UtcTimestamp;
use console_ops_application::obligations::{Context as ObContext, Error as SpoolError};
use console_ops_application::{
    Alert, AlertState as RawAlertState, AlertStatus, Alertmanager, AlertmanagerSnapshot,
    AlertmanagerStatus, InstantSample, ScrapeTarget, SourceError, SourceFuture, VersionInfo,
    VictoriaMetrics, Vmalert, VmalertSnapshot,
};
use console_ops_domain::bundle::{
    ComponentsMap, OpsSettings, validate_components_json, validate_ops_settings_json,
};
use serde_json::json;

pub type TestResult = Result<(), Box<dyn std::error::Error>>;

pub fn block_on<F: Future>(fut: F) -> F::Output {
    let mut fut = std::pin::pin!(fut);
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    loop {
        if let Poll::Ready(val) = fut.as_mut().poll(&mut cx) {
            return val;
        }
    }
}

pub struct MockAm(pub Mutex<Result<AlertmanagerSnapshot, SourceError>>);
impl Alertmanager for MockAm {
    fn read(&self) -> SourceFuture<'_, AlertmanagerSnapshot> {
        let res = match &*self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            Ok(s) => Ok(AlertmanagerSnapshot {
                alerts: s
                    .alerts
                    .iter()
                    .map(|a| Alert {
                        fingerprint: a.fingerprint.clone(),
                        labels: a.labels.clone(),
                        annotations: a.annotations.clone(),
                        starts_at: a.starts_at,
                        ends_at: a.ends_at,
                        status: AlertStatus {
                            state: match a.status.state {
                                RawAlertState::Active => RawAlertState::Active,
                                RawAlertState::Suppressed => RawAlertState::Suppressed,
                                RawAlertState::Unprocessed => RawAlertState::Unprocessed,
                            },
                            silenced_by: a.status.silenced_by.clone(),
                            inhibited_by: a.status.inhibited_by.clone(),
                        },
                    })
                    .collect(),
                silences: Vec::new(),
                status: AlertmanagerStatus {
                    version_info: VersionInfo {
                        version: s.status.version_info.version.clone(),
                    },
                    uptime: s.status.uptime,
                },
            }),
            Err(e) => Err(*e),
        };
        Box::pin(async move { res })
    }
}

pub struct MockVm(pub Mutex<Result<VmalertSnapshot, SourceError>>);
impl Vmalert for MockVm {
    fn read(&self) -> SourceFuture<'_, VmalertSnapshot> {
        let res = match &*self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            Ok(s) => Ok(VmalertSnapshot {
                groups: Vec::new(),
                alerts: s.alerts.clone(),
            }),
            Err(e) => Err(*e),
        };
        Box::pin(async move { res })
    }
}

pub struct MockVmetrics(pub Mutex<Result<BTreeMap<String, Vec<InstantSample>>, SourceError>>);
impl VictoriaMetrics for MockVmetrics {
    fn query_instant(&self, query: &str) -> SourceFuture<'_, Vec<InstantSample>> {
        let res = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|m| m.get(query).cloned().unwrap_or_default())
            .map_err(|e| *e);
        Box::pin(async move { res })
    }
    fn targets(&self) -> SourceFuture<'_, Vec<ScrapeTarget>> {
        let res = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|_| Vec::new())
            .map_err(|e| *e);
        Box::pin(async move { res })
    }
}

pub fn bundle() -> Result<(ComponentsMap, OpsSettings), Box<dyn std::error::Error>> {
    let comp = validate_components_json(
        &json!({
            "api": {
                "group": "app", "host": "onprem-1", "owner": "platform",
                "dashboard": "/running", "runbook": "https://example.invalid/runbook",
                "source": "victoriametrics", "interval_s": 60
            },
            "missing-svc": {
                "group": "app", "host": "onprem-1", "owner": "platform",
                "dashboard": null, "runbook": "https://example.invalid/runbook",
                "source": "victoriametrics", "interval_s": 60
            }
        })
        .to_string(),
    )?;
    let src = json!({
        "url": "http://example.invalid", "producer": "fixture", "interval_s": 60,
        "read_limits": {"request_timeout_ms": 500, "max_response_bytes": 4096}
    });
    let settings = validate_ops_settings_json(
        &json!({
            "sources": {"alertmanager": src, "vmalert": src, "victoriametrics": src},
            "access": {"team": "t", "aud": "a", "issuer": "https://example.invalid", "jwks": "/tmp/j.json", "interval_s": 60},
            "origin": "https://ops.example.invalid",
            "thresholds": {"rpo_limit_s": 900.0},
            "budgets": {"job.nightly.max_age_s": 3600}
        })
        .to_string(),
    )?;
    Ok((comp, settings))
}

pub fn sample(labels: &[(&str, &str)], val: f64) -> InstantSample {
    InstantSample {
        metric: labels
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        timestamp_s: 1767225600.0,
        value: val,
    }
}

pub struct MemAckStore(pub Mutex<Vec<AlertAckRecord>>);
impl AlertAckStore for MemAckStore {
    fn list_acks(&self) -> Result<Vec<AlertAckRecord>, SpoolError> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
    fn record_ack(
        &self,
        group_key: &str,
        alertname: &str,
        component: &str,
        note: Option<String>,
        context: &ObContext,
    ) -> Result<AlertAckRecord, SpoolError> {
        let mut g = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rec = AlertAckRecord {
            seq: g.len() as u64 + 1,
            hash: "h".into(),
            support_ref: context.support_ref.clone(),
            at: UtcTimestamp::new(context.at),
            operator: context.operator.person.clone(),
            group_key: group_key.to_owned(),
            alertname: alertname.to_owned(),
            component: component.to_owned(),
            note,
        };
        g.push(rec.clone());
        Ok(rec)
    }
}

pub struct MemSilenceStore(pub Mutex<Vec<SilenceAuditRecord>>);
impl SilenceAuditStore for MemSilenceStore {
    fn list_records(&self) -> Result<Vec<SilenceAuditRecord>, SpoolError> {
        Ok(self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
    fn record_event(
        &self,
        action: &str,
        silence_id: Option<&str>,
        group_key: Option<&str>,
        detail: Option<&str>,
        context: &ObContext,
    ) -> Result<SilenceAuditRecord, SpoolError> {
        let mut g = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rec = SilenceAuditRecord {
            seq: g.len() as u64 + 1,
            hash: "h".into(),
            support_ref: context.support_ref.clone(),
            at: UtcTimestamp::new(context.at),
            operator: context.operator.person.clone(),
            action: action.to_owned(),
            silence_id: silence_id.map(str::to_owned),
            group_key: group_key.map(str::to_owned),
            detail: detail.map(str::to_owned),
        };
        g.push(rec.clone());
        Ok(rec)
    }
}

pub struct MockWriter {
    pub fail: bool,
}
impl AlertmanagerWriter for MockWriter {
    fn create_silence(&self, _req: &AlertmanagerSilencePost) -> SourceFuture<'_, String> {
        let fail = self.fail;
        Box::pin(async move {
            if fail {
                Err(SourceError::Down)
            } else {
                Ok("sil-9".into())
            }
        })
    }
    fn delete_silence(&self, _id: &str) -> SourceFuture<'_, ()> {
        let fail = self.fail;
        Box::pin(async move { if fail { Err(SourceError::Down) } else { Ok(()) } })
    }
}
