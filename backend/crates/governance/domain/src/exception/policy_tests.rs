use super::*;
use console_kernel_core::ErrorKind;

const DAY: Duration = Duration::from_secs(86_400);

fn t0() -> Timestamp {
    Timestamp::UNIX_EPOCH
}

fn settings(mode: SoleHolderMode) -> ExceptionSettings {
    ExceptionSettings {
        approval_ttl_days: 14,
        sole_holder_mode: mode,
        sole_holder_review_due: DAY * 30,
    }
}

fn facts(other_eligible_holders: u64, step_up: bool) -> AdmissionFacts {
    AdmissionFacts {
        other_eligible_holders,
        step_up,
    }
}

fn code(err: KernelError) -> String {
    err.message
}

#[test]
fn low_is_recorded_without_step_up() {
    let a = admit(
        Risk::Low,
        facts(0, false),
        &settings(SoleHolderMode::Refuse),
        t0(),
    )
    .unwrap();
    assert_eq!(a.status, ExceptionStatus::Recorded);
    assert_eq!(a.fallback_kind, None);
    assert_eq!(a.expires_at, t0() + DAY * 14);
    assert!(!a.notify_executives);
}

#[test]
fn medium_without_step_up_is_refused() {
    let s = settings(SoleHolderMode::StepUpNoticeReview);
    let err = admit(Risk::Medium, facts(3, false), &s, t0()).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
    assert_eq!(code(err), "step_up_required");
    let a = admit(Risk::Medium, facts(3, true), &s, t0()).unwrap();
    assert_eq!(a.status, ExceptionStatus::Recorded);
}

#[test]
fn high_with_another_holder_waits_for_them_even_with_step_up() {
    for step_up in [false, true] {
        let a = admit(
            Risk::High,
            facts(1, step_up),
            &settings(SoleHolderMode::StepUpNoticeReview),
            t0(),
        )
        .unwrap();
        assert_eq!(a.status, ExceptionStatus::Pending);
        assert_eq!(a.fallback_kind, Some(FallbackKind::SecondPerson));
        assert_eq!(a.review_due_at, None);
        assert!(!a.notify_executives);
    }
}

#[test]
fn single_holder_tenant_gets_step_up_notice_and_review_not_a_dead_end() {
    let s = settings(SoleHolderMode::StepUpNoticeReview);
    let a = admit(Risk::High, facts(0, true), &s, t0()).unwrap();
    assert_eq!(a.status, ExceptionStatus::Recorded);
    assert_eq!(a.fallback_kind, Some(FallbackKind::SoleHolder));
    assert_eq!(a.review_due_at, Some(t0() + DAY * 30));
    assert!(a.notify_executives);
    assert_eq!(
        code(admit(Risk::High, facts(0, false), &s, t0()).unwrap_err()),
        "step_up_required"
    );
}

#[test]
fn refuse_mode_refuses_the_sole_holder_fallback() {
    let err = admit(
        Risk::High,
        facts(0, true),
        &settings(SoleHolderMode::Refuse),
        t0(),
    )
    .unwrap_err();
    assert_eq!(code(err), "exception_sole_holder_refused");
}

fn pending(requested_by: UserId) -> ExceptionRecord {
    ExceptionRecord {
        rule: RuleCode::LifecycleBackdatedClosedPeriod,
        status: ExceptionStatus::Pending,
        requested_by,
        subject_type: SubjectType::EmploymentEvent,
        subject_id: 7,
        fingerprint: "a".repeat(64),
        expires_at: t0() + DAY * 14,
        consumed: false,
    }
}

fn decider(decider: UserId, contributed: bool, step_up: bool) -> DeciderFacts {
    DeciderFacts {
        decider,
        contributed,
        step_up,
    }
}

#[test]
fn self_decision_is_refused() {
    let me = UserId::new();
    let err = decide(
        &pending(me),
        Decision::Approve,
        decider(me, false, true),
        t0(),
    )
    .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Forbidden);
    assert_eq!(code(err), "exception_self_decision");
    // Declining your own request is a decision too.
    let err = decide(
        &pending(me),
        Decision::Decline,
        decider(me, false, true),
        t0(),
    )
    .unwrap_err();
    assert_eq!(code(err), "exception_self_decision");
}

#[test]
fn contributor_and_missing_step_up_are_refused_then_other_person_approves() {
    let record = pending(UserId::new());
    let other = UserId::new();
    let d = |c, s| decide(&record, Decision::Approve, decider(other, c, s), t0());
    assert_eq!(
        code(d(true, true).unwrap_err()),
        "exception_contributor_decision"
    );
    assert_eq!(code(d(false, false).unwrap_err()), "step_up_required");
    assert_eq!(d(false, true).unwrap(), ExceptionStatus::Approved);
    let declined = decide(
        &record,
        Decision::Decline,
        decider(other, false, false),
        t0(),
    );
    assert_eq!(declined.unwrap(), ExceptionStatus::Declined);
}

#[test]
fn decide_requires_pending_and_unexpired() {
    let mut record = pending(UserId::new());
    let other = decider(UserId::new(), false, true);
    let at_expiry = record.expires_at;
    assert_eq!(
        code(decide(&record, Decision::Approve, other, at_expiry).unwrap_err()),
        "exception_expired"
    );
    record.status = ExceptionStatus::Approved;
    let err = decide(&record, Decision::Decline, other, t0()).unwrap_err();
    assert_eq!(err.kind, ErrorKind::InvalidTransition);
    assert_eq!(code(err), "exception_not_pending");
}

#[test]
fn guard_admits_one_matching_write_only() {
    let mut record = pending(UserId::new());
    let fp = record.fingerprint.clone();
    let rule = RuleCode::LifecycleBackdatedClosedPeriod;
    let check = |r: &ExceptionRecord, st, id, fp: &str, now| {
        check_admits(r, rule, st, id, fp, now).map_err(code)
    };
    let ee = SubjectType::EmploymentEvent;
    assert_eq!(
        check(&record, ee, 7, &fp, t0()).unwrap_err(),
        "exception_not_approved"
    );

    record.status = ExceptionStatus::Approved;
    assert_eq!(check(&record, ee, 7, &fp, t0()), Ok(()));
    // A recorded low-risk exception for the same payload is not the rule this write needs.
    let other_rule = check_admits(&record, RuleCode::SiblingNameDuplicate, ee, 7, &fp, t0());
    assert_eq!(code(other_rule.unwrap_err()), "exception_scope_changed");
    assert_eq!(
        check(&record, ee, 7, &"b".repeat(64), t0()).unwrap_err(),
        "exception_scope_changed"
    );
    assert_eq!(
        check(&record, ee, 8, &fp, t0()).unwrap_err(),
        "exception_scope_changed"
    );
    assert_eq!(
        check(&record, SubjectType::OrgChange, 7, &fp, t0()).unwrap_err(),
        "exception_scope_changed"
    );
    assert_eq!(
        check(&record, ee, 7, &fp, record.expires_at).unwrap_err(),
        "exception_expired"
    );

    record.consumed = true;
    assert_eq!(
        check(&record, ee, 7, &fp, t0()).unwrap_err(),
        "exception_consumed"
    );

    record.consumed = false;
    record.status = ExceptionStatus::Recorded;
    assert_eq!(check(&record, ee, 7, &fp, t0()), Ok(()));
    record.status = ExceptionStatus::Declined;
    assert_eq!(
        check(&record, ee, 7, &fp, t0()).unwrap_err(),
        "exception_not_approved"
    );
}
