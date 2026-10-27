// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use std::sync::{Arc, Mutex};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context, prelude::*};

#[derive(Clone, Default)]
pub struct Statements(Arc<Mutex<Vec<String>>>);

impl Statements {
    pub fn dispatch(&self) -> tracing::Dispatch {
        tracing::Dispatch::new(tracing_subscriber::registry().with(self.clone()))
    }
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl<S: Subscriber> Layer<S> for Statements {
    fn on_event(&self, event: &Event<'_>, _: Context<'_, S>) {
        if event.metadata().target() == "sqlx::query" {
            let mut statement = Statement::default();
            event.record(&mut statement);
            self.0.lock().unwrap().push(statement.0);
        }
    }
}

#[derive(Default)]
struct Statement(String);
impl Visit for Statement {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if matches!(field.name(), "db.statement" | "sql") {
            self.0 = format!("{value:?}");
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if matches!(field.name(), "db.statement" | "sql") {
            self.0 = value.to_owned();
        }
    }
}
