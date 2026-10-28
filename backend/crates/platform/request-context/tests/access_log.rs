// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::Principal;
use console_platform_request_context::audit_context::access_log::{
    AccessRecord, access_event, access_event_with_subject_refs,
};
use serde_json::json;
use uuid::Uuid;

#[test]
fn the_shared_writer_owns_self_read_and_reserved_fields() {
    let principal = Principal::new(
        UserId::new(),
        OrgId::new(),
        Default::default(),
        BranchScope::All,
    );
    let me = Uuid::new_v4();
    let other = Uuid::new_v4();
    for (subjects, users, own, expected) in [
        (vec![me], json!([]), Some(me), true),
        (vec![], json!([principal.user_id]), None, true),
        (vec![me], json!([principal.user_id]), Some(me), true),
        (vec![me, other], json!([]), Some(me), false),
        (vec![me], json!([other]), Some(me), false),
        (vec![], json!([]), Some(me), false),
    ] {
        let event = access_event(
            &principal,
            AccessRecord {
                action: "test.read",
                target_type: "employee",
                target_id: "query".into(),
                subject_ids: &subjects,
                reader_subject: own,
                details: json!({"user_subject_ids": users, "self_read": !expected,
                "subject_ids": [other], "subject_count": 999, "principal_type": "forged"}),
            },
        )
        .unwrap();
        let after = event.after.unwrap();
        assert_eq!(after["self_read"], expected);
        assert_eq!(after["subject_ids"], json!(subjects));
        assert_eq!(after["subject_count"], subjects.len());
        assert_eq!(after["principal_type"], "TENANT_USER");
    }
}

#[test]
fn immutable_subject_references_keep_reserved_fields_under_the_shared_writers_control() {
    let principal = Principal::new(
        UserId::new(),
        OrgId::new(),
        Default::default(),
        BranchScope::All,
    );
    let subjects = vec![format!("entity_documents:{}", Uuid::new_v4())];
    let event = access_event_with_subject_refs(
        &principal,
        AccessRecord {
            action: "entity_document.read",
            target_type: "entity_document",
            target_id: "test".into(),
            subject_ids: &[],
            reader_subject: None,
            details: json!({"subject_ids": ["forged"], "subject_count": 99, "self_read": true}),
        },
        &subjects,
    )
    .unwrap();
    let after = event.after.unwrap();
    assert_eq!(after["subject_ids"], json!(subjects));
    assert_eq!(after["subject_count"], 1);
    assert_eq!(after["self_read"], false);
    assert_eq!(event.actor, Some(principal.user_id));
}
