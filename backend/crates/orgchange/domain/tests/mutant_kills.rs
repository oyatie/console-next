#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Pins what cargo-mutants found unpinned in orgchange-domain (TS-7,
//! tools/lanes/mutants.sh): the stored spellings round-trip, unknown ones are
//! refused, the length and count limits hold at their edges, and the draft
//! window is exactly DRAFT and PRECHECKED.

use console_orgchange_domain::{
    ApprovalRoleKey, OrgChangeKind, OrgChangeStatus, OrgChangeTarget, OrgProposalOp, OrgUnitKind,
    SettlementKey, StepDecision, TargetKind, validate_proposal,
};
use serde_json::json;

macro_rules! round_trip {
    ($ty:ident: $($v:ident),+) => {{
        for v in [$($ty::$v),+] {
            assert_eq!($ty::from_db(v.as_db()).ok(), Some(v), "{v:?}");
            assert_eq!(serde_json::to_value(v).unwrap(), json!(v.as_db()), "{v:?} wire = stored");
        }
        assert!($ty::from_db("xyzzy").is_err());
        assert!($ty::from_db("").is_err());
    }};
}

#[test]
fn stored_spellings_round_trip_and_unknown_ones_are_refused() {
    round_trip!(OrgChangeKind: New, Reorg, Dissolve);
    round_trip!(TargetKind: Entity, Region, Branch, Site, OrgUnit);
    round_trip!(StepDecision: Pending, Approved, Rejected);
    round_trip!(OrgChangeStatus: Draft, Prechecked, InApproval, Approved, Applied, Settling, Archived, Rejected, Cancelled);
    for v in ApprovalRoleKey::ORDER {
        assert_eq!(ApprovalRoleKey::from_db(v.as_db()).ok(), Some(v));
    }
    assert!(ApprovalRoleKey::from_db("HR").is_err());
    for v in [OrgUnitKind::Site, OrgUnitKind::Department] {
        assert_eq!(OrgUnitKind::from_attr(v.as_attr()), Some(v));
    }
    assert_eq!(OrgUnitKind::as_attr(OrgUnitKind::Site), "site");
    assert_eq!(
        OrgUnitKind::from_attr("team"),
        Some(OrgUnitKind::Department)
    );
    assert_eq!(OrgUnitKind::from_attr("SITE"), None);
}

#[test]
fn settlement_labels_are_distinct_korean_text() {
    let labels: Vec<&str> = SettlementKey::ALL.iter().map(|k| k.label()).collect();
    for label in &labels {
        assert!(label.chars().any(|c| ('가'..='힣').contains(&c)), "{label}");
    }
    let mut unique = labels.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), labels.len());
}

#[test]
fn only_draft_and_prechecked_are_editable() {
    use OrgChangeStatus as S;
    for s in [S::Draft, S::Prechecked] {
        assert!(s.is_draft_editable(), "{s:?}");
    }
    for s in [
        S::InApproval,
        S::Approved,
        S::Applied,
        S::Settling,
        S::Archived,
        S::Rejected,
        S::Cancelled,
    ] {
        assert!(!s.is_draft_editable(), "{s:?}");
    }
}

fn op(value: serde_json::Value) -> OrgProposalOp {
    serde_json::from_value(value).unwrap()
}

fn create(name: &str) -> OrgProposalOp {
    op(json!({ "op": "CREATE_ORG_UNIT", "kind": "DEPARTMENT", "parentId": null, "name": name }))
}

#[test]
fn names_are_required_and_at_most_120_characters() {
    assert!(create("가").validate().is_ok());
    assert!(create(&"가".repeat(120)).validate().is_ok());
    for bad in [String::new(), "   ".to_owned(), "가".repeat(121)] {
        assert!(create(&bad).validate().is_err(), "{bad:?}");
    }
}

#[test]
fn a_target_needs_a_ref_and_a_label_within_200_characters() {
    let target = |r: &str, l: &str| OrgChangeTarget {
        kind: TargetKind::OrgUnit,
        target_ref: r.into(),
        label: l.into(),
    };
    assert!(target("u1", "영업팀").validate().is_ok());
    assert!(
        target(&"r".repeat(200), &"l".repeat(200))
            .validate()
            .is_ok()
    );
    for (r, l) in [
        ("", "영업팀"),
        ("u1", ""),
        ("u1", " "),
        (&*"r".repeat(201), "영업팀"),
        ("u1", &*"l".repeat(201)),
    ] {
        assert!(target(r, l).validate().is_err(), "{r:?} {l:?}");
    }
}

#[test]
fn a_reassign_needs_two_distinct_unit_uuids() {
    let from = uuid::Uuid::new_v4().to_string();
    let to = uuid::Uuid::new_v4().to_string();
    let reassign = |f: &str, t: &str| {
        op(
            json!({ "op": "REASSIGN_ORG_UNIT", "fromOrgUnit": f, "toOrgUnit": t, "scope": { "company": "가나" } }),
        )
    };
    assert!(reassign(&from, &to).validate().is_ok());
    for (f, t) in [(&*from, "영업팀"), ("영업팀", &*to), (&*from, &*from)] {
        assert!(reassign(f, t).validate().is_err(), "{f} -> {t}");
    }
}

#[test]
fn a_proposal_holds_at_most_100_ops() {
    let ops = |n: usize| vec![create("팀"); n];
    assert!(validate_proposal(&ops(100)).is_ok());
    assert!(validate_proposal(&ops(101)).is_err());
    assert!(validate_proposal(&[]).is_ok());
}
