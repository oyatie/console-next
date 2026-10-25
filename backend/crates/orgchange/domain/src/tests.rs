use super::*;

#[test]
fn allows_each_documented_transition() {
    use OrgChangeStatus as S;
    for (from, to) in [
        // The shipped submit path: preflight persists nothing.
        (S::Draft, S::InApproval),
        (S::Prechecked, S::Draft),
        (S::Prechecked, S::InApproval),
        // approval.policy.org_structure = none (decisions #26).
        (S::Draft, S::Approved),
        (S::Prechecked, S::Approved),
        (S::InApproval, S::Approved),
        (S::InApproval, S::Rejected),
        (S::Approved, S::Applied),
        // A legacy SETTLING 폐지 still archives (org-05: none opens now).
        (S::Settling, S::Archived),
        (S::Draft, S::Cancelled),
        (S::Prechecked, S::Cancelled),
        // org-02: a scheduled (APPROVED, not yet applied) change is cancelled.
        (S::Approved, S::Cancelled),
    ] {
        from.can_transition_to(to).expect("documented transition");
    }
}

#[test]
fn rejects_illegal_terminal_and_skip_transitions() {
    use OrgChangeStatus as S;
    for (from, to) in [
        // Preflight persists nothing: no caller may promote a DRAFT to
        // PRECHECKED. Re-introducing the write fails here, with no database.
        (S::Draft, S::Prechecked),
        (S::InApproval, S::Cancelled),
        (S::Approved, S::Archived),
        (S::Applied, S::Draft),
        (S::Archived, S::Settling),
        (S::Rejected, S::InApproval),
        (S::Cancelled, S::Draft),
        (S::Settling, S::Applied),
        // org-05: an applied 폐지 never opens a tick list again.
        (S::Approved, S::Settling),
    ] {
        assert!(from.can_transition_to(to).is_err(), "{from:?} -> {to:?}");
    }
}

#[test]
fn status_round_trips_through_db_vocabulary() {
    use OrgChangeStatus as S;
    for status in [
        S::Draft,
        S::Prechecked,
        S::InApproval,
        S::Approved,
        S::Applied,
        S::Settling,
        S::Archived,
        S::Rejected,
        S::Cancelled,
    ] {
        assert_eq!(S::from_db(status.as_db()).unwrap(), status);
    }
    assert!(S::from_db("BOGUS").is_err());
}

#[test]
fn terminal_statuses_are_exactly_the_four_documented_ones() {
    use OrgChangeStatus as S;
    let terminal: Vec<S> = [
        S::Draft,
        S::Prechecked,
        S::InApproval,
        S::Approved,
        S::Applied,
        S::Settling,
        S::Archived,
        S::Rejected,
        S::Cancelled,
    ]
    .into_iter()
    .filter(|s| s.is_terminal())
    .collect();
    assert_eq!(
        terminal,
        vec![S::Applied, S::Archived, S::Rejected, S::Cancelled]
    );
}

#[test]
fn summary_serializes_effective_date_as_iso_calendar_date() {
    let summary = OrgChangeSummary {
        id: Uuid::nil(),
        command_id: None,
        code: "OC-2026-0001".into(),
        kind: OrgChangeKind::Reorg,
        status: OrgChangeStatus::Draft,
        target: OrgChangeTarget {
            kind: TargetKind::Region,
            target_ref: Uuid::nil().to_string(),
            label: "수도권".into(),
        },
        effective_date: Date::from_calendar_date(2026, time::Month::July, 24).unwrap(),
        applies_at: None,
        created_unit_ids: None,
        reason: "개편".into(),
        headcount: 0,
        site_count: 0,
        team_count: 0,
        drafted_by: Uuid::nil(),
        drafted_by_name: None,
        created_at: OffsetDateTime::UNIX_EPOCH,
        updated_at: OffsetDateTime::UNIX_EPOCH,
        supersedes_id: None,
    };
    let json = serde_json::to_value(&summary).unwrap();
    // Without this pin the workspace `time` build (no serde-human-readable)
    // would emit `[2026, 205]` and break every generated client.
    assert_eq!(json["effectiveDate"], "2026-07-24");
}

#[test]
fn approval_chain_order_and_settlement_catalog_are_fixed() {
    assert_eq!(
        ApprovalRoleKey::ORDER.map(ApprovalRoleKey::as_db),
        ["hr", "finance", "legal", "executive"]
    );
    assert_eq!(SettlementKey::ALL.len(), 6);
    for key in SettlementKey::ALL {
        assert!(!key.label().is_empty());
        assert_eq!(
            serde_json::to_value(key).unwrap(),
            serde_json::Value::String(key.as_db().to_owned())
        );
    }
}
