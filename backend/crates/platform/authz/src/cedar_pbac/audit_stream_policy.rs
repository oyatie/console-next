use super::{CEO_COVERT_AUDIT_CLEARANCE_KEY, CEO_COVERT_AUDIT_STREAM_KEY};
use crate::Feature;

#[must_use]
pub fn generate_audit_stream_policies() -> String {
    let mut policies = String::new();
    for feature in [Feature::AuditStreamRead, Feature::AuditStreamAccessLogRead] {
        let action = feature.as_str();
        policies.push_str(&format!(
            "permit(\n  principal,\n  action == Action::\"{action}\",\n  resource\n)\nwhen {{\n  principal.org == resource.org &&\n  resource.resource_type == \"audit_stream\" &&\n  resource.resource_id == \"{stream}\" &&\n  principal.clearance_keys.contains(\"{clearance}\")\n}};\n",
            stream = CEO_COVERT_AUDIT_STREAM_KEY,
            clearance = CEO_COVERT_AUDIT_CLEARANCE_KEY
        ));
    }
    policies
}
