use super::*;

#[test]
fn valid_actions_accepted() {
    for ok in [
        "work_order.approve",
        "kpi.exclusion.revoke",
        "consent.withdraw",
    ] {
        let action = AuditAction::new(ok).expect(ok);
        assert_eq!((action.as_str(), action.to_string().as_str()), (ok, ok));
    }
}

#[test]
fn invalid_actions_rejected() {
    for bad in [
        "",
        "approve",
        "Work_Order.approve",
        "a..b",
        ".a.b",
        "a.b.",
        "a b.c",
    ] {
        assert!(AuditAction::new(bad).is_err(), "{bad:?} should be rejected");
    }
}

#[test]
fn action_serde_enforces_validation() {
    let ok: Result<AuditAction, _> = serde_json::from_str("\"work_order.start\"");
    assert!(ok.is_ok());
    let bad: Result<AuditAction, _> = serde_json::from_str("\"NotValid\"");
    assert!(bad.is_err());
}

#[test]
fn audit_event_serde_roundtrip_with_snapshots() {
    let action = AuditAction::new("work_order.approve").unwrap();
    let event = AuditEvent::new(
        Some(UserId::new()),
        action,
        "work_order",
        WorkOrderTargetFixture::id(),
        TraceContext::generate(),
        time::macros::datetime!(2026-06-12 00:00:00 UTC),
    )
    .with_branch(BranchId::new())
    .with_snapshots(
        Some(serde_json::json!({"status": "REPORT_SUBMITTED"})),
        Some(serde_json::json!({"status": "FINAL_COMPLETED"})),
    );
    let json = serde_json::to_string(&event).unwrap();
    let back: AuditEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(event, back);
}

#[test]
fn audit_event_serde_roundtrip_with_request_context_and_classification() {
    let event = AuditEvent::new(
        Some(UserId::new()),
        AuditAction::new("audit.read").unwrap(),
        "audit_log",
        "query",
        TraceContext::generate(),
        time::macros::datetime!(2026-07-09 00:00:00 UTC),
    )
    .with_request_context(AuditRequestContext {
        ip: Some("203.0.113.9".to_owned()),
        user_agent: Some("Maintenance Console/1.0".to_owned()),
        auth_method: Some("passkey".to_owned()),
        device: Some("desktop-web".to_owned()),
    })
    .with_classification(AuditClassification {
        badges: Some(vec!["민감정보".to_owned(), "대외비".to_owned()]),
        anomaly: Some(true),
        reason: Some("manager override".to_owned()),
    });

    let json = serde_json::to_string(&event).unwrap();
    let back: AuditEvent = serde_json::from_str(&json).unwrap();

    assert_eq!(back.request_context.ip.as_deref(), Some("203.0.113.9"));
    assert_eq!(back.request_context.auth_method.as_deref(), Some("passkey"));
    assert_eq!(
        back.classification.badges.as_deref(),
        Some(&["민감정보".to_owned(), "대외비".to_owned()][..])
    );
    assert_eq!(back.classification.anomaly, Some(true));
    assert_eq!(
        back.classification.reason.as_deref(),
        Some("manager override")
    );
    assert_eq!(event, back);
}

struct WorkOrderTargetFixture;
impl WorkOrderTargetFixture {
    fn id() -> String {
        crate::ids::WorkOrderId::new().to_string()
    }
}
