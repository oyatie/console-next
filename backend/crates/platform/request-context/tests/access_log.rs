// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::Principal;
use console_platform_request_context::audit_context::access_log::{AccessRecord, access_event};
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
