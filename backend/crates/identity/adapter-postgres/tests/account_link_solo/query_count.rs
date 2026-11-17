// SPDX-License-Identifier: LicenseRef-Proprietary
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tracing::{
    Event, Metadata, Subscriber,
    span::{Attributes, Id, Record},
};

#[derive(Clone, Default)]
pub struct QueryCount(Arc<AtomicUsize>);

impl QueryCount {
    pub fn get(&self) -> usize {
        self.0.load(Ordering::Relaxed)
    }
}

impl Subscriber for QueryCount {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        // Logging preflight can use different metadata; filter the emitted event instead.
        true
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        if event.metadata().target() == "sqlx::query" {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
}

#[test]
fn statement_counter_allows_preflight_but_counts_only_query_events() {
    let queries = QueryCount::default();
    tracing::subscriber::with_default(queries.clone(), || {
        if tracing::enabled!(tracing::Level::DEBUG) {
            tracing::debug!(target: "sqlx::query", "synthetic query");
        }
        tracing::debug!(target: "other", "not a query");
    });
    assert_eq!(queries.get(), 1);
}
