// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code)]
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use console_ops_application::alert_actions::{AlertmanagerSilencePost, AlertmanagerWriter};
use console_ops_application::health::StatusFeed;
use console_ops_application::{
    InstantSample, ScrapeTarget, SourceError, SourceFuture, VictoriaMetrics,
};
use console_ops_domain::status::{
    StatusComponentState, StatusEvidence, StatusEvidenceSample, StatusV2Snapshot,
};
use time::{Duration, OffsetDateTime};
use tokio::sync::watch;

pub struct TempRoot {
    pub root: PathBuf,
    pub config: PathBuf,
    pub records: PathBuf,
    pub releases: PathBuf,
    pub state: PathBuf,
    _shutdown: watch::Sender<bool>,
}

impl TempRoot {
    pub fn new() -> Result<(Self, watch::Receiver<bool>), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!("console-ops-oc1-{}", uuid::Uuid::new_v4()));
        let config = root.join("config");
        let records = root.join("records");
        let releases = root.join("releases");
        let state = root.join("state");
        fs::create_dir_all(config.join("runbooks"))?;
        fs::create_dir_all(&records)?;
        fs::create_dir_all(&releases)?;
        fs::create_dir_all(&state)?;
        let (tx, rx) = watch::channel(false);
        Ok((
            Self {
                root,
                config,
                records,
                releases,
                state,
                _shutdown: tx,
            },
            rx,
        ))
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Default)]
pub struct MockAmWriter {
    pub fail_next: AtomicBool,
    pub created: Mutex<Vec<AlertmanagerSilencePost>>,
    pub deleted: Mutex<Vec<String>>,
}

impl AlertmanagerWriter for MockAmWriter {
    fn create_silence(&self, req: &AlertmanagerSilencePost) -> SourceFuture<'_, String> {
        let fail = self.fail_next.swap(false, Ordering::SeqCst);
        let req_clone = req.clone();
        Box::pin(async move {
            if fail {
                return Err(SourceError::Down);
            }
            let mut guard = self
                .created
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let id = format!("sil-{}", guard.len() + 1);
            guard.push(req_clone);
            Ok(id)
        })
    }

    fn delete_silence(&self, id: &str) -> SourceFuture<'_, ()> {
        let fail = self.fail_next.swap(false, Ordering::SeqCst);
        let id_owned = id.to_owned();
        Box::pin(async move {
            if fail {
                return Err(SourceError::Down);
            }
            self.deleted
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(id_owned);
            Ok(())
        })
    }
}

pub struct MockStatusFeed {
    pub now: OffsetDateTime,
}

impl StatusFeed for MockStatusFeed {
    fn read(&self) -> SourceFuture<'_, StatusV2Snapshot> {
        let now = self.now;
        Box::pin(async move {
            Ok(StatusV2Snapshot {
                schema_uri: None,
                schema: 2,
                rev: 7,
                generated_at: now.into(),
                record_start: (now - Duration::days(30)).into(),
                evidence: StatusEvidence {
                    schema: 1,
                    samples: vec![StatusEvidenceSample {
                        at: now.into(),
                        components: [("api".to_owned(), StatusComponentState::Ok)].into(),
                        origin: None,
                        vantage: None,
                    }],
                },
                incidents: vec![],
                maintenances: vec![],
                vantage_counts: None,
                postmortems: None,
            })
        })
    }
}

pub struct Oc1Vm {
    pub now: OffsetDateTime,
}

impl VictoriaMetrics for Oc1Vm {
    fn query_instant(&self, query: &str) -> SourceFuture<'_, Vec<InstantSample>> {
        let ts = self.now.unix_timestamp() as f64;
        let out = if query.contains("job_last_exit_code") {
            vec![InstantSample {
                metric: [("job".into(), "walg-backup".into())].into(),
                value: 0.0,
                timestamp_s: ts,
            }]
        } else {
            Vec::new()
        };
        Box::pin(async move { Ok(out) })
    }
    fn targets(&self) -> SourceFuture<'_, Vec<ScrapeTarget>> {
        Box::pin(async move { Ok(Vec::new()) })
    }
}
