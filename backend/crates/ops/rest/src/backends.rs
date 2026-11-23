// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;
use std::path::Path;
use std::sync::Arc;

use console_ops_adapter_fs::{FsHostStateStore, FsReleasesStore, FsRunbookStore, SpoolSet};
use console_ops_application::VictoriaMetrics;
use console_ops_application::actions::ActionStore;
use console_ops_application::alert_actions::{
    AlertAckStore, AlertmanagerWriter, SilenceAuditStore,
};
use console_ops_application::changes::{HostStateStore, ReleasesStore};
use console_ops_application::events::OpsEvent;
use console_ops_application::health::StatusFeed;
use console_ops_application::incidents::IncidentStore;
use console_ops_application::obligations::ObligationStore;
use console_ops_application::promote::{FeedbackStore, PromotionStore};
use console_ops_application::runbooks::{RunbookStore, RunbooksService};
use console_ops_application::snapshot::SourceKind;
use console_ops_application::sources_status::SourceSlot;
use console_ops_application::victoriametrics::{VictoriaMetricsSnapshot, read_catalogue};
use console_ops_domain::bundle::{OncallConfig, OpsSettings};
use time::OffsetDateTime;
use tokio::sync::RwLock;

use crate::state::OpsRestState;

pub struct FsBackendPaths<'a> {
    pub config_dir: &'a Path,
    pub records_dir: Option<&'a Path>,
    pub releases_dir: Option<&'a Path>,
    pub state_dir: Option<&'a Path>,
}

pub fn attach_fs_backends(
    mut state: OpsRestState,
    paths: FsBackendPaths<'_>,
    due_soon_days: u32,
) -> OpsRestState {
    state.due_soon_days = due_soon_days;
    if let Some(records_dir) = paths.records_dir {
        let spools = SpoolSet::open_resilient(records_dir);
        state.obligations = Some(spools.obligations);
        state.ack_store = Some(spools.alerts);
        state.silence_store = Some(spools.silences);
        state.incidents = Some(spools.incidents);
        state.actions = Some(spools.actions);
        state.promotions = Some(spools.promotions);
        state.feedback = Some(spools.feedback);
    }
    if let Some(releases_dir) = paths.releases_dir {
        state.releases = Some(Arc::new(FsReleasesStore::new(releases_dir)));
    }
    if let Some(state_dir) = paths.state_dir
        && std::fs::symlink_metadata(state_dir)
            .map(|m| !m.file_type().is_symlink() && m.is_dir())
            .unwrap_or(false)
    {
        state.host_state = Some(Arc::new(FsHostStateStore::new(state_dir)));
    }
    state.runbooks = Some(Arc::new(FsRunbookStore::new(paths.config_dir)));
    state
}

pub fn validate_runbooks_dir(config_dir: &Path) -> Result<usize, String> {
    let store = FsRunbookStore::new(config_dir);
    let docs = store
        .list_docs()
        .map_err(|err| format!("runbooks validation failed: {err:?}"))?;
    if docs.is_empty() || !docs.iter().any(|d| d.path == "RUNBOOK.md") {
        return Err("runbooks/RUNBOOK.md must exist and be readable".to_owned());
    }
    let root_doc = store
        .read_doc("RUNBOOK.md")
        .map_err(|err| format!("runbooks/RUNBOOK.md unreadable: {err:?}"))?;
    if root_doc.content.trim().is_empty() {
        return Err("runbooks/RUNBOOK.md must not be empty".to_owned());
    }
    Ok(docs.len())
}

impl OpsRestState {
    pub fn with_settings(mut self, settings: OpsSettings) -> Self {
        self.due_soon_days = settings.due_soon_days();
        self.settings = Some(settings);
        self
    }

    pub fn with_obligations(
        mut self,
        store: Option<Arc<dyn ObligationStore>>,
        due_soon_days: u32,
    ) -> Self {
        self.obligations = store;
        self.due_soon_days = due_soon_days;
        self
    }

    pub fn with_alert_actions(
        mut self,
        ack_store: Option<Arc<dyn AlertAckStore>>,
        silence_store: Option<Arc<dyn SilenceAuditStore>>,
        am_writer: Option<Arc<dyn AlertmanagerWriter>>,
    ) -> Self {
        self.ack_store = ack_store;
        self.silence_store = silence_store;
        self.am_writer = am_writer;
        self
    }

    pub fn with_am_writer(mut self, am_writer: Arc<dyn AlertmanagerWriter>) -> Self {
        self.am_writer = Some(am_writer);
        self
    }

    pub fn with_incidents(mut self, store: Arc<dyn IncidentStore>) -> Self {
        self.incidents = Some(store);
        self
    }

    pub fn with_actions(mut self, store: Arc<dyn ActionStore>) -> Self {
        self.actions = Some(store);
        self
    }

    pub fn with_promote(
        mut self,
        promotions: Arc<dyn PromotionStore>,
        feedback: Arc<dyn FeedbackStore>,
    ) -> Self {
        self.promotions = Some(promotions);
        self.feedback = Some(feedback);
        self
    }

    pub fn with_releases(mut self, store: Arc<dyn ReleasesStore>) -> Self {
        self.releases = Some(store);
        self
    }

    pub fn with_runbooks(mut self, store: Arc<dyn RunbookStore>) -> Self {
        self.runbooks = Some(store);
        self
    }

    pub fn with_host_state(mut self, store: Arc<dyn HostStateStore>) -> Self {
        self.host_state = Some(store);
        self
    }

    pub fn with_status_feed(mut self, feed: Arc<dyn StatusFeed>) -> Self {
        self.status_feed = Some(feed);
        self
    }

    pub fn with_oncall(mut self, oncall: OncallConfig) -> Self {
        self.oncall = Some(oncall);
        self
    }

    pub fn with_bundle_sha(mut self, sha: impl Into<String>) -> Self {
        self.bundle_sha = Some(sha.into());
        self
    }

    pub fn with_victoriametrics(
        mut self,
        vm: Arc<dyn VictoriaMetrics>,
        producer: String,
        interval_s: NonZeroU64,
    ) -> Self {
        self.vm_source = Some(vm);
        self.vm_slot = Arc::new(RwLock::new(SourceSlot::new(
            "victoriametrics",
            SourceKind::VictoriaMetrics,
            producer,
            interval_s,
        )));
        self
    }

    pub fn with_vm_slot(mut self, slot: SourceSlot<VictoriaMetricsSnapshot>) -> Self {
        self.vm_slot = Arc::new(RwLock::new(slot));
        self
    }

    pub async fn emit_events(&self, events: Vec<OpsEvent>) {
        if events.is_empty() {
            return;
        }
        let pushed = {
            let mut guard = self.snapshots.write().await;
            events
                .into_iter()
                .map(|ev| guard.ring.push(ev))
                .collect::<Vec<_>>()
        };
        for ev in pushed {
            let _ = self.tx.send(ev);
        }
    }

    pub fn runbooks_service(&self) -> Option<RunbooksService<'_>> {
        self.runbooks.as_deref().map(|store| RunbooksService {
            store,
            bundle_sha: self.bundle_sha.clone(),
        })
    }

    pub async fn refresh_vm_slot(&self, now: OffsetDateTime) {
        let Some(vm) = &self.vm_source else {
            return;
        };
        let due = self.vm_slot.read().await.due(now);
        if !due {
            return;
        }
        let result = read_catalogue(&**vm).await;
        let mut slot = self.vm_slot.write().await;
        slot.begin_read(now);
        match result {
            Ok(snap) => slot.finish_ok(snap),
            Err(err) => slot.finish_err(err.to_string()),
        }
    }
}
