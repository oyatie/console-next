// SPDX-License-Identifier: LicenseRef-Proprietary
use serde_json::Value;
use uuid::Uuid;

pub fn fingerprint(bytes: &[u8]) -> Vec<u8> {
    let Ok(mut body) = serde_json::from_slice::<Value>(bytes) else {
        return bytes.to_vec();
    };
    if let Some(object) = body.as_object_mut() {
        object.remove("step_up");
    }
    body.sort_all_objects();
    serde_json::to_vec(&body).unwrap_or_else(|_| bytes.to_vec())
}
pub(super) fn target(path: &str) -> Option<(String, String, Option<Uuid>)> {
    let parts: Vec<_> = path.split('/').filter(|s| !s.is_empty()).collect();
    let (kind, id) = match parts.as_slice() {
        ["api", "v1", "employees", id, ..] => ("employee", *id),
        ["api", "v1", "legal-entities", id, ..] => ("legal_entity", *id),
        ["api", "v1", "workplaces", id, ..] => ("workplace", *id),
        ["api", "v1", "org-units", id, ..] => ("org_unit", *id),
        ["api", "v1", "business-registrations", id, ..] => ("business_registration", *id),
        ["api", "v1", "org-changes", id, ..] => ("org_change_request", *id),
        _ => return None,
    };
    Uuid::parse_str(id).ok()?;
    Some((kind.into(), id.into(), None))
}
