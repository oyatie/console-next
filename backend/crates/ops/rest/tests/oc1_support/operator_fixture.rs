// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{OPERATOR_EMAIL, READ_HOME_ONLY_EMAIL};
use aws_lc_rs::digest::{SHA256, digest};
use console_ops_rest::operators::VALID_ACTIONS;
use serde_json::{Value, json};
pub const COSIGNER_EMAIL: &str = "countersigner@console.invalid";

pub fn operators(from: &str, until: &str) -> String {
    let all_grants: Vec<Value> = VALID_ACTIONS
        .iter()
        .map(|a| json!({"action": a, "from": from, "until": until}))
        .collect();
    json!([
        {
            "person": "00000000-0000-4000-8000-000000000003",
            "email_sha256": hex::encode(digest(&SHA256, COSIGNER_EMAIL.as_bytes())),
            "grants": [{"action":"obligation.write","from":from,"until":until}]
        },
        {
            "person": "00000000-0000-4000-8000-000000000001",
            "email_sha256": hex::encode(digest(&SHA256, OPERATOR_EMAIL.as_bytes())),
            "grants": all_grants
        },
        {
            "person": "00000000-0000-4000-8000-000000000002",
            "email_sha256": hex::encode(digest(&SHA256, READ_HOME_ONLY_EMAIL.as_bytes())),
            "grants": [
                {"action": "read.me", "from": from, "until": until},
                {"action": "read.home", "from": from, "until": until}
            ]
        }
    ])
    .to_string()
}
