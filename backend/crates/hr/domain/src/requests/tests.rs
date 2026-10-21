use super::*;

const REQUESTER: Uuid = Uuid::from_u128(1);
const HR: Uuid = Uuid::from_u128(2);
const OTHER_HR: Uuid = Uuid::from_u128(3);

#[test]
fn the_requester_never_applies_or_declines_their_own_request() {
    for decision in [ChangeRequestDecision::Apply, ChangeRequestDecision::Decline] {
        assert_eq!(
            check_close("OPEN", REQUESTER, None, REQUESTER, decision),
            Err(CloseRefusal::SelfDecision)
        );
        assert_eq!(check_close("OPEN", REQUESTER, None, HR, decision), Ok(()));
    }
}

#[test]
fn only_the_requester_withdraws() {
    let withdraw = ChangeRequestDecision::Withdraw;
    assert_eq!(
        check_close("OPEN", REQUESTER, None, REQUESTER, withdraw),
        Ok(())
    );
    assert_eq!(
        check_close("OPEN", REQUESTER, None, HR, withdraw),
        Err(CloseRefusal::NotRequester)
    );
}

#[test]
fn a_named_assignee_is_the_only_second_person() {
    let apply = ChangeRequestDecision::Apply;
    assert_eq!(check_close("OPEN", REQUESTER, Some(HR), HR, apply), Ok(()));
    assert_eq!(
        check_close("OPEN", REQUESTER, Some(HR), OTHER_HR, apply),
        Err(CloseRefusal::NotAssignee)
    );
}

#[test]
fn a_closed_request_stays_closed() {
    for status in ["APPLIED", "DECLINED", "WITHDRAWN"] {
        assert_eq!(
            check_close(status, REQUESTER, None, HR, ChangeRequestDecision::Apply),
            Err(CloseRefusal::AlreadyClosed)
        );
    }
}

#[test]
fn kinds_round_trip_and_other_needs_a_note() {
    for kind in ChangeRequestKind::ALL {
        assert_eq!(ChangeRequestKind::parse(kind.as_str()).unwrap(), kind);
    }
    assert!(ChangeRequestKind::parse("RENAME").is_err());
    let other = ChangeRequestKind::Other;
    assert!(other.review_required());
    assert_eq!(
        validate_new_request(other, "BRANCH", HR, None, Some("  "))
            .unwrap_err()
            .field
            .as_deref(),
        Some("note")
    );
    validate_new_request(other, "BRANCH", HR, None, Some("지점 폐쇄 후 처리")).unwrap();
    assert_eq!(
        validate_new_request(
            ChangeRequestKind::ProfileCorrection,
            "BRANCH",
            HR,
            None,
            None
        )
        .unwrap_err()
        .field
        .as_deref(),
        Some("subject_type")
    );
}

#[test]
fn an_access_explanation_is_named_to_the_account_it_asks_and_answered_with_a_note() {
    let kind = ChangeRequestKind::AccessExplanation;
    assert!(kind.answered_by_assignee());
    assert!(!ChangeRequestKind::ProfileCorrection.answered_by_assignee());
    for assignee in [None, Some(HR)] {
        assert_eq!(
            validate_new_request(kind, "USER_ACCOUNT", REQUESTER, assignee, None)
                .unwrap_err()
                .field
                .as_deref(),
            Some("assignee_user_id")
        );
    }
    validate_new_request(kind, "USER_ACCOUNT", REQUESTER, Some(REQUESTER), None).unwrap();
    assert!(validate_new_request(kind, "EMPLOYEE", REQUESTER, Some(REQUESTER), None).is_err());
    let apply = ChangeRequestDecision::Apply;
    assert!(validate_answer(kind, apply, Some(" ")).is_err());
    validate_answer(kind, apply, Some("월말 정산 확인 업무")).unwrap();
    validate_answer(kind, ChangeRequestDecision::Withdraw, None).unwrap();
    validate_answer(ChangeRequestKind::ScopeAction, apply, None).unwrap();
    validate_new_request(
        ChangeRequestKind::PolicyQuestion,
        "ORGANIZATION",
        HR,
        None,
        None,
    )
    .unwrap();
}
