// SPDX-License-Identifier: LicenseRef-Proprietary
//! Observe SQLx statements in the product future, without a Postgres extension.
use std::sync::{Arc, Mutex};
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
#[derive(Clone, Default)]
pub struct Queries(pub Arc<Mutex<Vec<String>>>);
struct Fields(String);
impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.push_str(&format!("{}={value:?} ", field.name()));
    }
}
impl Queries {
    pub fn statements(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
    pub fn scans(&self) -> usize {
        self.statements()
            .iter()
            .filter(|s| s.contains("filtered AS") && s.contains(" LIMIT $"))
            .count()
    }
}
impl Subscriber for Queries {
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
        let mut fields = Fields(String::new());
        event.record(&mut fields);
        self.0.lock().unwrap().push(fields.0);
    }
    fn max_level_hint(&self) -> Option<tracing::metadata::LevelFilter> {
        Some(tracing::metadata::LevelFilter::DEBUG)
    }
}
