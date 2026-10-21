#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_platform_test_support::strict_json;

#[test]
fn unknown_fields_create_object_link_request() {
    strict_json::rejects_unknown::<super::CreateObjectLinkRequest>();
}
