//! Employee identity resolution read from import row metadata.
//! Moved from `app/src/hr.rs` (R2-import).

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmployeeIdentityResolution {
    pub strategy: String,
    pub confidence: String,
    pub review_required: bool,
    pub name_only_merge: bool,
}

pub fn employee_identity_resolution_from_metadata(metadata: &Value) -> EmployeeIdentityResolution {
    let identity = metadata
        .get("identity_resolution")
        .and_then(Value::as_object);
    let strategy = identity
        .and_then(|value| value.get("strategy"))
        .and_then(Value::as_str)
        .filter(|value| {
            matches!(
                *value,
                "employee_number"
                    | "legal_identifier_hash"
                    | "birth_hire_fingerprint"
                    | "source_row_fingerprint"
            )
        })
        .unwrap_or("source_row_fingerprint")
        .to_owned();
    let confidence = match strategy.as_str() {
        "employee_number" | "legal_identifier_hash" => "high",
        "birth_hire_fingerprint" => "medium",
        _ => "low",
    }
    .to_owned();
    let explicit_review_clearance = identity
        .and_then(|value| value.get("manual_review_required"))
        .and_then(Value::as_bool)
        == Some(false);
    let review_required = !(explicit_review_clearance
        && matches!(
            strategy.as_str(),
            "employee_number" | "legal_identifier_hash"
        ));

    EmployeeIdentityResolution {
        strategy,
        confidence,
        review_required,
        // Name-only merging is not a supported identity strategy. Even if stale
        // or malicious import metadata claims otherwise, keep the public record
        // non-mergeable until HR performs an explicit reviewed resolution.
        name_only_merge: false,
    }
}
