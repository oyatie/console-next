// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_application::domain::ladders::{EvidenceState, WorkKind};
use console_ops_application::domain::obligation::{Event as ObEvent, Obligation};
use console_ops_application::events::OpsEvent;
use console_ops_application::home_worklist::build_obligation_home_parts;
use console_ops_application::obligations::{
    Entry, Error as SpoolError, Item, ObligationItemView, Operator, Record,
};
use console_ops_application::victoriametrics::ALL_QUERIES;
use serde_json::json;
use time::{Duration, macros::datetime};

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[test]
fn obligation_home_parts_use_now_as_observed_at_and_handle_broken_chain() -> TestResult {
    let now = datetime!(2026-11-20 00:00 UTC);
    let old = now - Duration::days(10);
    let interval = NonZeroU64::new(60).ok_or("nonzero")?;

    let broken = build_obligation_home_parts(Err(SpoolError::ChainBroken(3)), now, 7, interval);
    assert!(broken.0.text.contains("record chain broken at 3"));
    assert_eq!(broken.2.state, EvidenceState::Unknown);

    let ob = Obligation::evolve(
        None,
        &serde_json::from_value::<ObEvent>(json!({
            "event": "opened",
            "fields": {
                "kind": "launch-gate",
                "reviewer_role": "owner",
                "title": "Synthetic gate",
                "due": "2026-11-22"
            }
        }))?,
    )
    .map_err(|e| format!("{e:?}"))?;

    let items = vec![Item {
        id: "1".into(),
        obligation: ob.clone(),
    }];
    let records = vec![Record {
        seq: 1,
        hash: "h".into(),
        support_ref: "s1".into(),
        entry: Entry {
            at: old,
            operator: Operator {
                person: "op".into(),
                method: "access-jwt".into(),
            },
            obligation_id: "1".into(),
            event: serde_json::from_value::<ObEvent>(json!({
                "event": "opened",
                "fields": {
                    "kind": "launch-gate",
                    "reviewer_role": "owner",
                    "title": "Synthetic gate",
                    "due": "2026-11-22"
                }
            }))?,
        },
    }];

    let (readiness, work, src) =
        build_obligation_home_parts(Ok((&items, &records)), now, 7, interval);
    assert_eq!(readiness.text, "Blocked: 1 launch gate open");
    assert_eq!(work.len(), 1);
    assert_eq!(work[0].kind, WorkKind::Obligation);
    assert_eq!(work[0].since.state(), EvidenceState::Verified);
    assert_eq!(work[0].since.observed_at(), Some(now));
    assert_eq!(src.name, "obligations");

    let ev_ob = OpsEvent::ObligationChanged {
        id: 1,
        evaluated_at: now,
        item: ObligationItemView::from_item(items[0].clone(), now),
    };
    assert_eq!(ev_ob.event_type(), "obligation.changed");
    assert_eq!(ev_ob.required_action(), "obligation.read");
    assert!(ALL_QUERIES.contains(&"ops:evidence_ok"));
    assert!(ALL_QUERIES.contains(&"console_status_feed_read_ok"));
    assert!(ALL_QUERIES.contains(&"console_oncall_synthetic_page_ok"));
    Ok(())
}
