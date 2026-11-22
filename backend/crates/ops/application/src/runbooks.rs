// SPDX-License-Identifier: LicenseRef-Proprietary
use console_ops_domain::runbook::RunbookAnchor;
use serde::Serialize;
use time::OffsetDateTime;

use crate::sources_status::SourceSlot;
use crate::victoriametrics::{QUERY_CONFIG_BUNDLE_INFO, VictoriaMetricsSnapshot};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunbookDocMeta {
    pub path: String,
    pub anchors: Vec<RunbookAnchor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunbookDoc {
    pub path: String,
    pub content: String,
    pub anchors: Vec<RunbookAnchor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunbookError {
    NotFound,
    InvalidPath,
    Unreadable,
}

pub trait RunbookStore: Send + Sync {
    fn list_docs(&self) -> Result<Vec<RunbookDocMeta>, RunbookError>;
    fn read_doc(&self, rel_path: &str) -> Result<RunbookDoc, RunbookError>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunbookListView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub bundle_sha: Option<String>,
    pub deployed_sha: Option<String>,
    pub stale_warning: Option<String>,
    pub docs: Vec<RunbookDocMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunbookDocView {
    #[serde(with = "time::serde::rfc3339")]
    pub evaluated_at: OffsetDateTime,
    pub bundle_sha: Option<String>,
    pub deployed_sha: Option<String>,
    pub stale_warning: Option<String>,
    pub doc: RunbookDoc,
}

pub struct RunbooksService<'a> {
    pub store: &'a dyn RunbookStore,
    pub bundle_sha: Option<String>,
}

impl<'a> RunbooksService<'a> {
    fn staleness(
        &self,
        vm: &SourceSlot<VictoriaMetricsSnapshot>,
    ) -> (Option<String>, Option<String>, Option<String>) {
        let deployed_sha = vm.current.as_ref().and_then(|snap| {
            snap.series
                .get(QUERY_CONFIG_BUNDLE_INFO)
                .and_then(|v| v.first())
                .and_then(|s| s.metric.get("sha"))
                .cloned()
        });
        let warning = match (&self.bundle_sha, &deployed_sha) {
            (Some(b), Some(d)) if b != d => {
                Some("Bundle older than deployed sha: runbook may not match".to_owned())
            }
            _ => None,
        };
        (self.bundle_sha.clone(), deployed_sha, warning)
    }

    pub fn list(
        &self,
        vm: &SourceSlot<VictoriaMetricsSnapshot>,
        now: OffsetDateTime,
    ) -> Result<RunbookListView, RunbookError> {
        let docs = self.store.list_docs()?;
        let (bundle_sha, deployed_sha, stale_warning) = self.staleness(vm);
        Ok(RunbookListView {
            evaluated_at: now,
            bundle_sha,
            deployed_sha,
            stale_warning,
            docs,
        })
    }

    pub fn read(
        &self,
        rel_path: &str,
        vm: &SourceSlot<VictoriaMetricsSnapshot>,
        now: OffsetDateTime,
    ) -> Result<RunbookDocView, RunbookError> {
        let doc = self.store.read_doc(rel_path)?;
        let (bundle_sha, deployed_sha, stale_warning) = self.staleness(vm);
        Ok(RunbookDocView {
            evaluated_at: now,
            bundle_sha,
            deployed_sha,
            stale_warning,
            doc,
        })
    }
}
