// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! What an item says about postponing it, and the dates the presets resolve to.
use console_action_inbox_application::*;
use serde_json::json;
use time::macros::{date, datetime};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

/// Thursday noon in Korea.
const NOW: OffsetDateTime = datetime!(2026-11-12 03:00 UTC);
const TODAY: Date = date!(2026 - 11 - 12);
const LATER: Date = date!(2026 - 11 - 19);

fn item(namespace: &str, n: u128) -> ActionInboxSourceItem {
    ActionInboxSourceItem {
        context: None,
        due_basis: None,
        id: format!("{namespace}:{}", Uuid::from_u128(n)),
        kind: namespace.to_owned(),
        ref_code: String::new(),
        title: format!("Item {n}"),
        site: None,
        who: None,
        due: None,
        submitted: None,
        links: Vec::new(),
        created_at: NOW,
    }
}

#[test]
fn an_item_says_whether_and_until_when_it_may_be_postponed() {
    let statutory_due = datetime!(2026-11-20 23:59:59 +9);
    let rows = [
        ActionInboxSourceItem {
            kind: "org_change_approve".into(),
            ..item("org_change", 1)
        },
        ActionInboxSourceItem {
            due: Some(statutory_due),
            due_basis: Some(DueBasis::Statutory),
            ..item("hr_exit", 2)
        },
        ActionInboxSourceItem {
            due: Some(statutory_due),
            ..item("hr_request", 3)
        },
        ActionInboxSourceItem {
            due: Some(datetime!(2026-11-13 23:59:59 +9)),
            due_basis: Some(DueBasis::Statutory),
            ..item("hr_insurance", 4)
        },
    ];
    let page = merge_pages(
        vec![ActionInboxSourcePage {
            total: rows.len(),
            items: rows.to_vec(),
            total_is_exact: true,
            has_more: false,
        }],
        NOW,
        NOW,
        None,
        10,
        7,
    );
    let facts = |n: u128| {
        let row = page
            .items
            .iter()
            .find(|row| row.id.ends_with(&Uuid::from_u128(n).to_string()))
            .unwrap();
        (
            serde_json::to_value(&row.snooze).unwrap(),
            row.snooze.clone(),
        )
    };
    let (wire, decision) = facts(1);
    assert_eq!(wire, json!({"allowed": false, "reason": "blocks_others"}));
    assert_eq!(decision.check(LATER, TODAY), Err(SnoozeRefusal::NotAllowed));

    let (wire, legal) = facts(2);
    assert_eq!(wire, json!({"allowed": true, "latest": "2026-11-19"}));
    assert_eq!(legal.check(date!(2026 - 11 - 19), TODAY), Ok(()));
    assert_eq!(
        legal.check(date!(2026 - 11 - 20), TODAY),
        Err(SnoozeRefusal::PastLegalDue(date!(2026 - 11 - 19)))
    );

    let (wire, plain) = facts(3);
    assert_eq!(wire, json!({"allowed": true}));
    assert_eq!(plain.check(date!(2027 - 01 - 01), TODAY), Ok(()));
    for past in [TODAY, date!(2026 - 11 - 11)] {
        assert_eq!(plain.check(past, TODAY), Err(SnoozeRefusal::Past));
        assert_eq!(decision.check(past, TODAY), Err(SnoozeRefusal::Past));
    }
    // Due tomorrow under the law: no day is left, so no control is offered and the deadline refuses.
    let (wire, last) = facts(4);
    assert_eq!(wire, json!({"allowed": false, "latest": "2026-11-12"}));
    assert_eq!(
        last.check(date!(2026 - 11 - 13), TODAY),
        Err(SnoozeRefusal::PastLegalDue(TODAY))
    );
    assert_eq!(
        serde_json::from_value::<SnoozeFacts>(json!({"allowed": true, "latest": "2026-11-19"}))
            .unwrap(),
        legal
    );
}

#[test]
fn presets_resolve_to_dates_and_next_week_is_the_coming_monday() {
    let dates = |today, short, long| serde_json::to_value(presets(today, short, long)).unwrap();
    assert_eq!(
        dates(TODAY, 1, 7),
        json!([
            {"key": "short", "date": "2026-11-13"},
            {"key": "next_week", "date": "2026-11-16"},
            {"key": "long", "date": "2026-11-19"},
        ])
    );
    // On a Monday next week is seven days on; on a Sunday it is tomorrow.
    assert_eq!(dates(date!(2026 - 11 - 16), 3, 30)[1]["date"], "2026-11-23");
    assert_eq!(
        dates(date!(2026 - 11 - 15), 3, 30),
        json!([
            {"key": "short", "date": "2026-11-18"},
            {"key": "next_week", "date": "2026-11-16"},
            {"key": "long", "date": "2026-12-15"},
        ])
    );
    assert_eq!(
        kst_date(datetime!(2026-11-12 15:00 UTC)),
        date!(2026 - 11 - 13)
    );
}
