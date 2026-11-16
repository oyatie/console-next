// SPDX-License-Identifier: LicenseRef-Proprietary
//! Observe SQLx statements in the product future, without a Postgres extension.
use std::sync::{Arc, Mutex, OnceLock};
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};
#[derive(Clone)]
pub struct Queries(pub Arc<Mutex<Vec<String>>>);
impl Default for Queries {
    fn default() -> Self {
        // Retain SQLx callsite interest between observers scoped to individual futures.
        static DISPATCH: OnceLock<tracing::Dispatch> = OnceLock::new();
        DISPATCH.get_or_init(|| tracing::Dispatch::new(Self(Arc::default())));
        Self(Arc::default())
    }
}
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
    #[allow(dead_code)]
    pub fn statutory_register_reads(&self) -> Vec<String> {
        self.statements()
            .into_iter()
            .filter(|sql| sql.contains("FROM lifecycle_statutory_rules r"))
            .collect()
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
