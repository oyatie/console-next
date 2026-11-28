// SPDX-License-Identifier: LicenseRef-Proprietary
use super::RestError;
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use console_compliance_application::ComplianceControlPage;
use console_compliance_domain::{ComplianceControl, ControlStatus};
use console_kernel_core::KernelError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub(super) struct ControlQuery {
    pub(super) framework_id: String,
    pub(super) limit: Option<i64>,
    pub(super) offset: Option<i64>,
    pub(super) q: Option<String>,
    pub(super) status: Option<ControlStatus>,
}

/// An explicit null must reach validation even when the other spelling is present.
pub(super) fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

pub(super) fn requirements(
    legacy: Option<Value>,
    items: Option<Vec<Value>>,
) -> Result<Value, RestError> {
    match (legacy, items) {
        (Some(original), Some(items)) if original.as_array() != Some(&items) => Err(
            RestError::from_kernel(KernelError::validation("conflicting evidence requirements")),
        ),
        (Some(original), _) => Ok(original),
        (None, items) => Ok(Value::Array(items.unwrap_or_default())),
    }
}

#[derive(Serialize)]
struct Control<'a> {
    #[serde(flatten)]
    record: &'a ComplianceControl,
    evidence_requirement_items: &'a Value,
}

impl<'a> From<&'a ComplianceControl> for Control<'a> {
    fn from(record: &'a ComplianceControl) -> Self {
        Self {
            record,
            evidence_requirement_items: &record.evidence_requirements,
        }
    }
}

pub(super) fn control(record: &ComplianceControl) -> Response {
    Json(Control::from(record)).into_response()
}

pub(super) fn page(page: &ComplianceControlPage) -> Response {
    #[derive(Serialize)]
    struct Page<'a> {
        items: Vec<Control<'a>>,
        limit: i64,
        offset: i64,
        total: i64,
    }
    Json(Page {
        items: page.items.iter().map(Control::from).collect(),
        limit: page.limit,
        offset: page.offset,
        total: page.total,
    })
    .into_response()
}
