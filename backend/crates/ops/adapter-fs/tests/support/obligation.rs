// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_ops_application::obligations::Context;
use serde_json::{Value, json};

pub fn context() -> Context {
    serde_json::from_value(json!({
        "at":"2026-10-27T00:00:00Z",
        "operator":{"person":"00000000-0000-4000-8000-000000000001","method":"access"},
        "support_ref":"synthetic-ref"
    }))
    .unwrap()
}

pub fn opened(title: &str) -> Value {
    json!({"event":"opened","fields":{"kind":"drill","reviewer_role":"owner","title":title}})
}
