//! MR-26 after 운영 시작: the governed void (a second person, or a sole
//! holder's step-up), its refusals, the kept 사번 and the PII destruction.

use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_hr_adapter_postgres::registration_void::VoidOutcome;
use console_hr_adapter_postgres::requests::{CreateChangeRequest, DecideChangeRequest};
use console_platform_test_support::soft_passkey::passkey_service;
use serde_json::json;
use sqlx::PgPool;

use crate::fixture::fixture;
use crate::void::{
    SECOND, code, go_live, register, second_hr, tombstone, version, visible, void_body,
};
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_void_after_go_live_is_decided_by_a_second_person_and_keeps_the_number(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    // 입사 예정: PRE_HIRE with a SCHEDULED ONBOARD.
    let id = register(&f, "v-1", "2030-01-02", "").await;
    let number: String = sqlx::query_scalar("SELECT employee_number FROM employees WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let org = *f.principal.org_id.as_uuid();
    let passkeys = passkey_service();
    assert_eq!(
        code(
            f.hr.void_employee(
                f.principal.clone(),
                &passkeys,
                id,
                void_body(version(&pool, id).await, false),
                SECOND,
            )
            .await
        ),
        (409, "phase_not_operating")
    );
    go_live(&pool, org).await;
    let pending: VoidOutcome =
        f.hr.void_employee(
            f.principal.clone(),
            &passkeys,
            id,
            void_body(version(&pool, id).await, false),
            SECOND,
        )
        .await
        .unwrap();
    assert_eq!(pending.status, "PENDING");
    assert!(visible(&f, id).await, "nothing changes until the decision");
    let request = pending.pending_request.unwrap();
    assert_eq!(request.kind, "EMPLOYEE_VOID");
    let decider = second_hr(&pool, &f).await;
    let decide: DecideChangeRequest =
        serde_json::from_value(json!({ "decision": "APPLY", "reason_code": "CONFIRMED" })).unwrap();
    f.hr.decide_change_request(decider, request.id, decide, SECOND)
        .await
        .unwrap();
    assert!(!visible(&f, id).await);
    let (status, name, kept, mode, destroyed) = tombstone(&pool, id).await;
    assert_eq!(
        (status.as_str(), kept.as_deref(), mode.as_str(), destroyed),
        ("VOIDED", Some(number.as_str()), "GOVERNED", false)
    );
    assert_eq!(
        name, "김등록",
        "personal data stays until the retention ends"
    );
    let onboard: String = sqlx::query_scalar(
        "SELECT state FROM employee_lifecycle_events WHERE employee_id = $1 AND event_type = 'ONBOARD'",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        onboard, "CANCELLED",
        "the runner never brings the person back"
    );
    // The 사번 stays taken (decisions #6), and the next generated one skips it.
    let mut taken = f.body("v-2", "REGULAR");
    taken.employee_number = number.clone();
    assert_eq!(code(f.create(taken).await), (409, "employee_number_taken"));
    let next = register(&f, "v-3", "2026-09-01", "").await;
    let next_number: String =
        sqlx::query_scalar("SELECT employee_number FROM employees WHERE id = $1")
            .bind(next)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(next_number, number);
    // After people.void_pii_retention (30 days) the tick tombstones it.
    assert_eq!(f.hr.destroy_due_void_pii().await.unwrap(), 0);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET voided_at = voided_at - interval '31 days' WHERE id = $1")
        .bind(id)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(f.hr.destroy_due_void_pii().await.unwrap(), 1);
    let (_, name, kept, _, destroyed) = tombstone(&pool, id).await;
    assert_eq!(
        (name.as_str(), kept.as_deref(), destroyed),
        ("(파기됨)", Some(number.as_str()), true)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_started_registration_needs_the_attestation_and_a_worked_one_is_exited(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let id = register(&f, "w-1", "2026-09-01", "").await;
    go_live(&pool, *f.principal.org_id.as_uuid()).await;
    let passkeys = passkey_service();
    let attempt = |attest: bool, holders: SecondPersonContext| {
        let (f, pool, passkeys) = (&f, &pool, &passkeys);
        async move {
            f.hr.void_employee(
                f.principal.clone(),
                passkeys,
                id,
                void_body(version(pool, id).await, attest),
                holders,
            )
            .await
        }
    };
    assert_eq!(
        code(attempt(false, SECOND).await),
        (409, "employee_void_attestation_required")
    );
    let refuse = SecondPersonContext {
        other_eligible_holders: 0,
        routed: true,
        sole_holder_refuse: true,
    };
    assert_eq!(
        code(attempt(true, refuse).await),
        (403, "employee_void_sole_holder_refused")
    );
    let sole = SecondPersonContext {
        other_eligible_holders: 0,
        routed: true,
        sole_holder_refuse: false,
    };
    assert_eq!(code(attempt(true, sole).await), (401, "step_up_required"));
    // An applied 발령 beyond the ONBOARD is a work record: 퇴직, not 취소.
    sqlx::query(
        "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, effective_date, \
           from_status, to_status, comment, created_by) \
         SELECT org_id, id, 'PROMOTE', hire_date, 'ACTIVE', 'ACTIVE', 'test', $2 \
         FROM employees WHERE id = $1",
    )
    .bind(id)
    .bind(*f.principal.user_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        code(attempt(true, SECOND).await),
        (409, "employee_void_has_work_records")
    );
    // A void request is never filed by hand.
    // Built directly: the wire validator refuses this kind before the domain, and the case
    // exercises the domain's own refusal.
    let by_hand = CreateChangeRequest {
        kind: "EMPLOYEE_VOID".into(),
        subject_type: "EMPLOYEE".into(),
        subject_id: id,
        payload: Some(json!({ "attest_never_worked": true })),
        reason_code: "NEVER_JOINED".into(),
        note: None,
        assignee_user_id: None,
    };
    assert_eq!(
        code(
            f.hr.create_change_request(f.principal.clone(), by_hand)
                .await
        )
        .0,
        422
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_concurrent_pii_runs_tombstone_each_record_once(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let ids = [
        register(&f, "c-1", "2026-09-01", "").await,
        register(&f, "c-2", "2026-09-01", "").await,
    ];
    for id in ids {
        // Voided 31 days ago (owner-side, triggers off), past the default 30.
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL session_replication_role = replica")
            .execute(tx.as_mut())
            .await
            .unwrap();
        sqlx::query(
            "UPDATE employees SET employment_status = 'VOIDED', \
             voided_at = now() - interval '31 days', voided_by = $2, \
             void_reason_code = 'NEVER_JOINED', void_mode = 'GOVERNED' WHERE id = $1",
        )
        .bind(id)
        .bind(*f.principal.user_id.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    // Two replicas' ticks at once: SKIP LOCKED hands each record to one run.
    let (a, b) = tokio::join!(f.hr.destroy_due_void_pii(), f.hr.destroy_due_void_pii());
    assert_eq!(a.unwrap() + b.unwrap(), 2);
    for id in ids {
        assert!(tombstone(&pool, id).await.4, "personal data destroyed");
    }
    assert_eq!(f.hr.destroy_due_void_pii().await.unwrap(), 0);
}
