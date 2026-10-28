// SPDX-License-Identifier: LicenseRef-Proprietary
use serde_json::Value;

pub(super) fn assert_decision_error(body: &Value) {
    let envelope = body.as_object().expect("decision error object");
    // The shared HTTP middleware adds RFC 9457 fields to the legacy error envelope.
    assert!(
        envelope
            .keys()
            .all(|key| matches!(key.as_str(), "error" | "type" | "title" | "status")),
        "unexpected top-level member: {body}"
    );
    let error = envelope["error"].as_object().expect("error object");
    for field in ["code", "message"] {
        assert!(
            error
                .get(field)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty()),
            "missing error.{field}: {body}"
        );
    }
    assert!(
        !error.contains_key("current_version"),
        "opaque versions belong in optional details: {body}"
    );
    if let Some(details) = error.get("details") {
        let details = details.as_object().expect("error details object");
        if let Some(version) = details.get("current_version") {
            assert!(
                version.is_string(),
                "opaque current_version must be a string: {body}"
            );
        }
    }
}

#[test]
fn decision_error_rejects_malformed_envelopes() {
    assert_decision_error(&serde_json::json!({"error":{"code":"conflict","message":"refused"}}));
    assert_decision_error(
        &serde_json::json!({"error":{"code":"conflict","message":"refused"},"type":"about:blank","title":"refused","status":409}),
    );
    for body in [
        serde_json::json!({"error":{"code":"conflict","message":"refused"},"unexpected":true}),
        serde_json::json!({}),
        serde_json::json!({"error":{"code":"conflict"}}),
        serde_json::json!({"error":{"code":"conflict","message":"refused","details":{"current_version":1}}}),
        serde_json::json!({"error":{"code":"conflict","message":"refused","current_version":"opaque"}}),
    ] {
        assert!(
            std::panic::catch_unwind(|| assert_decision_error(&body)).is_err(),
            "accepted malformed decision error: {body}"
        );
    }
}
