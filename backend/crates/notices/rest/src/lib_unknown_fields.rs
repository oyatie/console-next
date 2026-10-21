#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_create_draft_body() {
    strict_json::rejects_unknown::<super::CreateDraftBody>();
}

#[test]
fn unknown_fields_update_draft_body() {
    strict_json::rejects_unknown::<super::UpdateDraftBody>();
}
