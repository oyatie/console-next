//! W05: group answers.

use std::collections::BTreeMap;

use super::{World, row};
use crate::import::plan::{Decisions, Exclusion};
use crate::import::plan_group::group_key_ok;
use crate::import::review::review_queue;

fn out(code: &str) -> Exclusion {
    Exclusion {
        reason_code: code.into(),
        note: None,
    }
}

fn rows() -> Vec<crate::import::plan::ImportRow> {
    let mut rows = Vec::new();
    for i in 0..3 {
        let mut r = row(&format!("bad{i}"), Some(&format!("E-{i}")), "김일");
        r.hire_date = Some("어느 날".into());
        rows.push(r);
    }
    let mut birth = row("birth", Some("E-7"), "김칠");
    birth.birth_date = Some("모름".into());
    rows.push(birth);
    let mut none = row("none", Some("E-8"), "김팔");
    none.hire_date = None;
    rows.push(none);
    rows
}

/// regression (W05): 88 blockers were answerable only one row at a time.
#[test]
fn regression_one_answer_excludes_every_row_with_that_reason_and_field() {
    let world = World::new(vec![]);
    let rows = rows();
    let plan = world.plan(&rows, &Decisions::default());
    let queue = review_queue(&rows, &plan, &[], &|_: &str, _: &str| None);
    let groups: Vec<_> = queue
        .groups
        .iter()
        .map(|g| (g.key.as_str(), g.rows))
        .collect();
    assert_eq!(
        groups,
        [("invalid_date:hire_date", 3)],
        "single-row reasons are not grouped"
    );
    assert_eq!(queue.groups[0].resolution.decision, "group_exclusions");

    let decisions = Decisions {
        group_exclusions: BTreeMap::from([("invalid_date:hire_date".into(), out("OUT_OF_SCOPE"))]),
        ..Decisions::default()
    };
    let plan = world.plan(&rows, &decisions);
    let outcomes: Vec<_> = plan
        .iter()
        .map(|p| (p.outcome, p.exclusion_code.as_deref()))
        .collect();
    assert_eq!(
        outcomes,
        [
            ("excluded", Some("OUT_OF_SCOPE")),
            ("excluded", Some("OUT_OF_SCOPE")),
            ("excluded", Some("OUT_OF_SCOPE")),
            ("refused", None),
            ("refused", None),
        ]
    );
}

#[test]
fn a_bare_reason_covers_every_field_and_a_row_answer_wins() {
    let world = World::new(vec![]);
    let rows = rows();
    let decisions = Decisions {
        group_exclusions: BTreeMap::from([("invalid_date".into(), out("OUT_OF_SCOPE"))]),
        exclusions: BTreeMap::from([("bad0".into(), out("DUPLICATE"))]),
        ..Decisions::default()
    };
    let plan = world.plan(&rows, &decisions);
    assert_eq!(plan[0].exclusion_code.as_deref(), Some("DUPLICATE"));
    assert!(plan[1..4].iter().all(|p| p.outcome == "excluded"));
    assert_eq!(
        (plan[4].outcome, plan[4].refusal_code),
        ("refused", Some("hire_date_required"))
    );
}

#[test]
fn a_group_key_names_a_known_reason_and_target_only() {
    for ok in [
        "invalid_date",
        "invalid_date:hire_date",
        "unresolved_identity:name",
    ] {
        assert!(group_key_ok(ok), "{ok}");
    }
    for bad in [
        "",
        "insert",
        "invalid_date:",
        "invalid_date:salary",
        "rrn_invalid",
        "Invalid_Date",
    ] {
        assert!(!group_key_ok(bad), "{bad}");
    }
}
