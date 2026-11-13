// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_action_inbox_application::ActionInboxItem;
use time::macros::datetime;

#[test]
fn inbox_deadlines_and_submissions_are_fractional_utc_strings() {
    let at = datetime!(2026-11-05 12:31:02.238349 +09:00);
    for optional in [Some(at), None] {
        let item = ActionInboxItem {
            age_days: 0,
            due_basis: None,
            fold_key: "item".into(),
            context: None,
            id: "item".into(),
            kind: "approval".into(),
            urg: "wait",
            ref_code: "REF".into(),
            title: "확인".into(),
            site: None,
            who: None,
            due: optional,
            due_tone: "neutral",
            submitted: optional,
            links: vec![],
            done: false,
            lane: "turn",
            days_remaining: None,
            created_at: at,
        };
        let wire = serde_json::to_value(item).unwrap();
        for field in ["due", "submitted"] {
            if optional.is_some() {
                assert_eq!(wire[field], "2026-11-05T03:31:02.238349Z", "{field}");
            } else {
                assert!(wire.get(field).is_none(), "{field}");
            }
        }
        assert!(wire.get("created_at").is_none());
    }
}
