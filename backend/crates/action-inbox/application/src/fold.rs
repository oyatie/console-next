// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::ActionInboxSourceItem;

/// Display text never participates in the identity of a related task.
pub(super) fn key(item: &ActionInboxSourceItem) -> String {
    let link = item.links.first();
    let insurance = item.context.as_ref().and_then(|c| c.get("insurance"));
    let subject = insurance
        .and_then(|i| i.get("employee_id"))
        .and_then(|v| v.as_str())
        .or_else(|| link.map(|l| l.id.as_str()))
        .unwrap_or(&item.id);
    let case = insurance
        .and_then(|i| {
            i.get("group_id")
                .filter(|v| v.is_string())
                .or_else(|| i.get("case_id"))
        })
        .and_then(|v| v.as_str())
        .unwrap_or(&item.id);
    let fold_kind = insurance
        .and_then(|i| i.get("kind"))
        .and_then(|v| v.as_str())
        .map_or_else(|| item.kind.clone(), |kind| format!("{}:{kind}", item.kind));
    serde_json::json!([fold_kind, subject, case]).to_string()
}
