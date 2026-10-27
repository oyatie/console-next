// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_ops_adapter_fs::{AppendError, RecordSpool};
use serde_json::{Map, Value, json};
use std::{
    fs,
    sync::{Arc, Mutex},
};
use tracing::{Event, Metadata, Subscriber, field::Visit, span};
mod support;
use support::Temp;

#[derive(Clone, Default)]
struct Export(Arc<Mutex<Vec<String>>>);
impl Visit for Export {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "record" {
            self.0.lock().unwrap().push(format!("{value:?}"));
        }
    }
}
impl Subscriber for Export {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
        span::Id::from_u64(1)
    }
    fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
    fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
    fn event(&self, event: &Event<'_>) {
        event.record(&mut self.clone());
    }
    fn enter(&self, _: &span::Id) {}
    fn exit(&self, _: &span::Id) {}
}

#[test]
fn the_exported_record_is_exactly_the_durable_json_and_refusals_export_nothing() {
    let tmp = Temp::new();
    let spool = RecordSpool::open(&tmp.0).unwrap();
    let export = Export::default();
    tracing::subscriber::set_global_default(export.clone()).unwrap();
    {
        spool
            .append("synthetic-support-ref", |_| {
                let mut document = json!({
                    "at": "2026-10-27T00:00:00Z",
                    "operator": {"person": "00000000-0000-4000-8000-000000000001", "method": "access"},
                    "obligation_id": "log-export",
                    "event": "opened",
                    "fields": {"kind": "drill", "reviewer_role": "owner", "title": "Synthetic restore drill"}
                }).as_object().unwrap().clone();
                document["fields"]["evidence_ref"] = "plain text\nwith a line break".into();
                Ok::<_, ()>(document)
            })
            .unwrap();
        let result = spool.append("synthetic-support-ref", |_| {
            Err::<Map<String, Value>, _>("refused")
        });
        assert!(matches!(result, Err(AppendError::Rejected("refused"))));
    }
    let lines = export.0.lock().unwrap();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].as_bytes(), fs::read(tmp.record(1)).unwrap());
    assert!(!lines[0].contains('\n'));
}
