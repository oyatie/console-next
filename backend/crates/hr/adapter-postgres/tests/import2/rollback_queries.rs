// SPDX-License-Identifier: LicenseRef-Proprietary
//! Count actual SQLx dependency statements in the driver future, without a server extension.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};

#[derive(Clone, Default)]
pub(super) struct DependencyQueries(Arc<[AtomicUsize; 2]>);

impl DependencyQueries {
    pub(super) fn counts(&self) -> [usize; 2] {
        self.0.each_ref().map(|n| n.load(Ordering::Relaxed))
    }
}

struct Statement<'a>(&'a DependencyQueries);
impl Visit for Statement<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() != "db.statement" {
            return;
        }
        let query = format!("{value:?}");
        for (i, marker) in ["import_rollback:heads", "import_rollback:blockers"]
            .iter()
            .enumerate()
        {
            if query.contains(marker) {
                self.0.0[i].fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

impl Subscriber for DependencyQueries {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.target() == "sqlx::query"
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        event.record(&mut Statement(self));
    }
    fn max_level_hint(&self) -> Option<tracing::metadata::LevelFilter> {
        Some(tracing::metadata::LevelFilter::DEBUG)
    }
}
