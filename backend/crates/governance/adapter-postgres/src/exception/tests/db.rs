//! BW-06 persistence, run as the genuine runtime role `console_rt` (FORCE RLS,
//! no BYPASSRLS). The owner pool only seeds and inspects.

use super::*;
use crate::exception::get_exception_conn;
use console_governance_domain::exception::{FallbackKind, SoleHolderMode};
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::Role;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::BTreeSet;
use std::time::Duration;

const ORG_A: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_00E6);
const ORG_B: Uuid = Uuid::from_u128(0xB000_0000_0000_0000_0000_0000_0000_00E6);
const DAY: Duration = Duration::from_secs(86_400);

fn settings() -> ExceptionSettings {
    ExceptionSettings {
        approval_ttl_days: 14,
        sole_holder_mode: SoleHolderMode::StepUpNoticeReview,
        sole_holder_review_due: DAY * 30,
    }
}

async fn runtime_pool(owner: &PgPool) -> PgPool {
    PgPoolOptions::new()
        .max_connections(4)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(owner.connect_options().as_ref().clone())
        .await
        .unwrap()
}

async fn seed(owner: &PgPool, org: Uuid) -> (UserId, UserId) {
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Org')")
        .bind(org)
        .bind(format!("org-{}", org.simple()))
        .execute(owner)
        .await
        .unwrap();
    let mut users = Vec::new();
    for name in ["Requester", "Decider"] {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO users (display_name, roles, org_id) VALUES ($1, '{SUPER_ADMIN}', $2) RETURNING id",
        )
        .bind(name)
        .bind(org)
        .fetch_one(owner)
        .await
        .unwrap();
        users.push(UserId::from_uuid(id));
    }
    (users[0], users[1])
}

async fn org_tx(pool: &PgPool, org: Uuid) -> Transaction<'static, Postgres> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    tx
}

/// A same-tenant decider; the holder fact rides on the decision.
fn decider(user: UserId) -> Principal {
    let org = OrgId::from_uuid(ORG_A);
    Principal::new(
        user,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    )
}

fn code(err: PgGovernanceError) -> String {
    match err {
        PgGovernanceError::Domain(e) => e.message,
        PgGovernanceError::Db(e) => format!("db: {e}"),
    }
}

fn day(y: i32, m: time::Month, d: u8) -> time::Date {
    time::Date::from_calendar_date(y, m, d).unwrap()
}

fn period(from: time::Date) -> EffectivePeriod {
    EffectivePeriod::new(from, Some(from.next_day().unwrap()))
}

fn request<'a>(
    rule: RuleCode,
    by: UserId,
    payload: &'a Value,
    periods: &'a [EffectivePeriod],
    others: u64,
    step_up: Option<Uuid>,
) -> ExceptionRequest<'a> {
    ExceptionRequest {
        rule,
        subject_type: SubjectType::EmploymentEvent,
        subject_id: Uuid::from_u128(7),
        reason_code: "CORRECTION",
        note: Some("  "),
        payload,
        affected_periods: periods,
        requested_by: by,
        step_up_assertion_id: step_up,
        other_eligible_holders: others,
    }
}

fn write<'a>(
    rule: RuleCode,
    payload: &'a Value,
    periods: &'a [EffectivePeriod],
) -> GovernedWrite<'a> {
    GovernedWrite {
        rule,
        subject_type: SubjectType::EmploymentEvent,
        subject_id: Uuid::from_u128(7),
        payload,
        affected_periods: periods,
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recorded_exception_admits_exactly_its_own_write_once(owner: PgPool) {
    let (me, _) = seed(&owner, ORG_A).await;
    let rt = runtime_pool(&owner).await;
    let mut tx = org_tx(&rt, ORG_A).await;
    let payload = json!({"effective_date": "2026-03-01", "to_unit": "U1"});
    let d = day(2026, time::Month::March, 1);
    let periods = [
        period(d),
        period(d.replace_month(time::Month::January).unwrap()),
    ];
    let rule = RuleCode::SiblingNameDuplicate;
    let req = request(rule, me, &payload, &periods, 0, None);
    let made = request_exception_conn(&mut tx, &req, &settings())
        .await
        .unwrap();
    assert_eq!(made.admission.status, ExceptionStatus::Recorded);

    let stored = get_exception_conn(&mut tx, made.id).await.unwrap().unwrap();
    assert_eq!(stored.note, None, "a blank note is no note");

    // A different rule, payload or period set is a different write.
    let other = json!({"effective_date": "2026-03-02", "to_unit": "U1"});
    let high = RuleCode::LifecycleBackdatedClosedPeriod;
    for w in [
        write(high, &payload, &periods),
        write(rule, &other, &periods),
        write(rule, &payload, &periods[..1]),
    ] {
        let err = consume_exception_conn(&mut tx, made.id, &w)
            .await
            .unwrap_err();
        assert_eq!(code(err), "exception_scope_changed");
    }
    // Same periods in another order: same fingerprint.
    let reordered = [periods[1], periods[0]];
    consume_exception_conn(&mut tx, made.id, &write(rule, &payload, &reordered))
        .await
        .unwrap();
    let again = consume_exception_conn(&mut tx, made.id, &write(rule, &payload, &periods)).await;
    assert_eq!(code(again.unwrap_err()), "exception_consumed");
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn high_risk_waits_for_a_distinct_second_person(owner: PgPool) {
    let (me, other) = seed(&owner, ORG_A).await;
    let rt = runtime_pool(&owner).await;
    let mut tx = org_tx(&rt, ORG_A).await;
    let payload = json!({"x": 1});
    let rule = RuleCode::LifecycleBackdatedClosedPeriod;
    let req = request(rule, me, &payload, &[], 2, None);
    let made = request_exception_conn(&mut tx, &req, &settings())
        .await
        .unwrap();
    assert_eq!(made.admission.status, ExceptionStatus::Pending);
    let w = write(rule, &payload, &[]);
    let early = consume_exception_conn(&mut tx, made.id, &w).await;
    assert_eq!(code(early.unwrap_err()), "exception_not_approved");

    let (me, other) = (decider(me), decider(other));
    let decision = |decider, step_up| ExceptionDecision {
        decision: Decision::Approve,
        decider,
        contributed: false,
        holds_permission: true,
        step_up_assertion_id: step_up,
        reason_code: "OK",
        note: None,
    };
    let own = decide_exception_conn(&mut tx, made.id, &decision(&me, Some(Uuid::new_v4()))).await;
    assert_eq!(code(own.unwrap_err()), "exception_self_decision");
    let bare = decide_exception_conn(&mut tx, made.id, &decision(&other, None)).await;
    assert_eq!(code(bare.unwrap_err()), "step_up_required");
    // Cedar `exception_decide`: a non-holder passes the domain rules and is
    // still refused, and nothing is written.
    let outsider = ExceptionDecision {
        holds_permission: false,
        ..decision(&other, Some(Uuid::new_v4()))
    };
    let refused = decide_exception_conn(&mut tx, made.id, &outsider).await;
    assert_eq!(
        code(refused.unwrap_err()),
        "exception_decide is not allowed"
    );
    let still = get_exception_conn(&mut tx, made.id).await.unwrap().unwrap();
    assert_eq!(still.status, ExceptionStatus::Pending);
    let status = decide_exception_conn(&mut tx, made.id, &decision(&other, Some(Uuid::new_v4())))
        .await
        .unwrap();
    assert_eq!(status, ExceptionStatus::Approved);
    let twice =
        decide_exception_conn(&mut tx, made.id, &decision(&other, Some(Uuid::new_v4()))).await;
    assert_eq!(code(twice.unwrap_err()), "exception_not_pending");
    consume_exception_conn(&mut tx, made.id, &w).await.unwrap();
    tx.commit().await.unwrap();

    // The DB backstop holds even for a writer that skips the domain.
    let pending = {
        let mut tx = org_tx(&rt, ORG_A).await;
        let id = request_exception_conn(&mut tx, &req, &settings())
            .await
            .unwrap()
            .id;
        tx.commit().await.unwrap();
        id
    };
    let raw = sqlx::query(
        "UPDATE governed_exceptions SET status = 'DECLINED', decided_by = requested_by, \
         decided_at = now(), decision_reason_code = 'X' WHERE id = $1",
    )
    .bind(pending)
    .execute(&owner)
    .await
    .unwrap_err();
    assert!(
        raw.to_string()
            .contains("governed_exceptions_no_self_decision"),
        "{raw}"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sole_holder_gets_step_up_and_review_instead_of_a_dead_end(owner: PgPool) {
    let (me, _) = seed(&owner, ORG_A).await;
    let rt = runtime_pool(&owner).await;
    let mut tx = org_tx(&rt, ORG_A).await;
    let payload = json!({});
    let rule = RuleCode::OrgChangeBackdated;
    let bare = request_exception_conn(
        &mut tx,
        &request(rule, me, &payload, &[], 0, None),
        &settings(),
    )
    .await;
    assert_eq!(code(bare.unwrap_err()), "step_up_required");
    let req = request(rule, me, &payload, &[], 0, Some(Uuid::new_v4()));
    let made = request_exception_conn(&mut tx, &req, &settings())
        .await
        .unwrap();
    assert_eq!(made.admission.status, ExceptionStatus::Recorded);
    assert!(made.admission.notify_executives);
    let stored = get_exception_conn(&mut tx, made.id).await.unwrap().unwrap();
    assert_eq!(stored.fallback_kind, Some(FallbackKind::SoleHolder));
    assert_eq!(stored.review_due_at, made.admission.review_due_at);
    assert!(stored.review_due_at.is_some());
}

#[path = "records.rs"]
mod records;
