//! The directory item's closed key allowlist, a child of `org_setup` kept apart so
//! the pinned parent file does not grow.

use super::*;

pub(super) fn assert_directory_item_json_allowlist(page: &Value) {
    const ALLOWED_KEYS: &[&str] = &[
        "person_id",
        "principal_kind",
        "id",
        "display_name",
        "sign_in_id",
        "employee_id",
        "employee_name",
        "employee_number",
        "employee_company",
        "employee_org_unit",
        "employee_position",
        "employee_identity_review_required",
        "employee_identity_resolution_confidence",
        "employee_link_status",
        "team",
        "roles",
        "branch_ids",
        "is_active",
        "is_tenant_ops",
        "has_passkey",
        "account_status",
        "created_at",
    ];
    const FORBIDDEN_KEYS: &[&str] = &[
        "phone",
        "phone_e164",
        "compensation",
        "base_pay",
        "currency",
        "bank_account",
        "account_number",
        "wage",
        "salary",
        "payroll",
        "rrn",
        "won",
    ];
    let allowed = ALLOWED_KEYS.iter().copied().collect::<BTreeSet<_>>();
    let items = page["items"]
        .as_array()
        .expect("directory page items must be an array");
    assert!(
        !items.is_empty(),
        "directory page must include at least one person"
    );
    for item in items {
        let object = item.as_object().expect("directory item must be an object");
        let keys = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
        assert!(
            item.get("id").is_some(),
            "directory item must have id; keys={keys:?}"
        );
        assert!(
            item.get("display_name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty()),
            "directory item must have display_name; keys={keys:?}"
        );
        assert_eq!(
            keys, allowed,
            "directory item JSON keys must match the DirectoryPerson allowlist"
        );
        for forbidden in FORBIDDEN_KEYS {
            assert!(
                item.get(*forbidden).is_none(),
                "directory item must omit {forbidden}; keys={keys:?}"
            );
        }
    }
}
