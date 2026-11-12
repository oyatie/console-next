// SPDX-License-Identifier: LicenseRef-Proprietary
use std::sync::{Arc, Mutex};
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record},
};

#[derive(Clone, Default)]
pub struct Warnings(Arc<Mutex<Vec<String>>>);
impl Warnings {
    pub fn messages(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}
struct Fields(String);
impl Visit for Fields {
    fn record_debug(&mut self, _: &Field, value: &dyn std::fmt::Debug) {
        self.0.push_str(&format!("{value:?}"));
    }
}
impl Subscriber for Warnings {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        *metadata.level() <= tracing::Level::WARN
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
        Some(tracing::metadata::LevelFilter::WARN)
    }
}
