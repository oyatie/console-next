// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use serde_json::Value;

pub(super) fn assert_unattested_publish(body: &Value) {
    assert_eq!(body["error"]["code"], "PREFLIGHT_FAILED");
    assert_eq!(body["publishable"], false);
    assert!(
        body["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["key"] == "exposure_attested" && check["ok"] == false),
        "check vector must name the unmet attest: {body}"
    );
}
