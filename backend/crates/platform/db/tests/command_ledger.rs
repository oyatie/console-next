#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The ledger's transactional and tenant boundaries under the real runtime role.
#[path = "command_ledger_support/mod.rs"]
mod support;
use console_platform_db::{
    DbError, command_context,
    command_outcomes::{self, Reservation},
    insert_audit_event, with_audits, with_org_conn,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::Fixture;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn applied_business_result_audit_and_value_free_notification_commit_together(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let id = f.fresh("atomic-command-key").await;
    assert_eq!(f.outcome(id).await.state, "PROCESSING");
    f.apply(id, "record-a").await.unwrap();
    let settled = f.outcome(id).await;
    assert_eq!(settled.state, "APPLIED");
    assert_eq!(settled.result, Some(json!({"id":"record-a"})));
    assert!(settled.settled_at.is_some());
    assert_eq!(settled.inputs_masked, json!({"masked":true}));
    assert_eq!(f.domain_count().await, 1);
    assert_eq!(f.audit_count(id, "ledger.apply").await, 1);
    let touched = settled.touched.as_array().unwrap();
    assert_eq!(touched.len(), 1);
    assert_eq!(touched[0]["type"], "ledger_probe");
    assert_eq!(touched[0]["id"], "record-a");
    let audit_id = uuid::Uuid::parse_str(touched[0]["audit_id"].as_str().unwrap()).unwrap();
    let link: Option<uuid::Uuid> =
        sqlx::query_scalar("SELECT command_id FROM audit_events WHERE id=$1")
            .bind(audit_id)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(link, Some(id));
    let emitted: Vec<Option<uuid::Uuid>> = sqlx::query_scalar(
        "SELECT resource_id FROM resource_changes
        WHERE org_id=$1 AND audit_event_id=$2 AND resource_type='command_outcome'",
    )
    .bind(f.org.as_uuid())
    .bind(id)
    .fetch_all(&f.owner)
    .await
    .unwrap();
    assert_eq!(emitted, vec![None]);
    assert!(
        matches!(f.reserve("atomic-command-key",b"original").await,Reservation::Existing(ref out) if out.state=="APPLIED")
    );
    let second = f.apply(id, "record-b").await.unwrap_err();
    assert!(second.to_string().contains("already settled"));
    assert_eq!(f.domain_count().await, 1);
    assert_eq!(f.audit_count(id, "ledger.apply").await, 1);
    let org = f.org;
    let event = f.event(Some(id), "ledger.apply", "second-raw", false);
    let raw = with_org_conn::<_, (), DbError>(&f.rt, org, move |tx| {
        Box::pin(async move {
            support::write(tx, org, "second-raw").await?;
            insert_audit_event(tx, &event).await
        })
    })
    .await
    .unwrap_err();
    assert!(raw.to_string().contains("already settled"));
    assert_eq!(f.domain_count().await, 1);
    assert_eq!(f.audit_count(id, "ledger.apply").await, 1);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn rollback_then_refusal_keeps_only_negative_audit_and_never_result(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let id = f.fresh("refused-command-key").await;
    let org = f.org;
    let failed: Result<(), DbError> = command_context::scope(
        f.context(Some(id)),
        with_audits(&f.rt, org, move |tx| {
            Box::pin(async move {
                support::write(tx, org, "rolled-back").await?;
                command_outcomes::set_result(tx, &json!({"id":"rolled-back"})).await?;
                Err(DbError::Sqlx(sqlx::Error::Protocol(
                    "validation_error".into(),
                )))
            })
        }),
    )
    .await;
    assert!(failed.unwrap_err().to_string().contains("validation_error"));
    assert_eq!(f.domain_count().await, 0);
    assert_eq!(f.audit_count(id, "ledger.apply").await, 0);
    let processing = f.outcome(id).await;
    assert_eq!(processing.state, "PROCESSING");
    assert_eq!(processing.result, None);
    f.deny(id, "validation_error").await;
    let refused = f.outcome(id).await;
    assert_eq!(refused.state, "REFUSED");
    assert_eq!(refused.refusal_code.as_deref(), Some("validation_error"));
    assert_eq!(refused.result, None);
    assert_eq!(refused.touched, json!([]));
    assert_eq!(f.domain_count().await, 0);
    let audit = f.masked_audit(id).await;
    assert_eq!(audit["source"], "FORM");
    assert_eq!(audit["actor_kind"], "OPS_ACCOUNT");
    assert_eq!(audit["outcome"], "DENIED");
    assert_eq!(audit["version"], 2);
    assert_eq!(
        audit["decision_snapshot"]["approval.policy.org_structure"],
        7
    );
    assert!(audit["decision_snapshot"].as_object().unwrap().len() > 20);
    f.deny(id, "validation_error").await;
    assert_eq!(
        f.audit_count(id, "command.refused").await,
        1,
        "terminal refusal cannot append twice"
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn concurrent_identical_reservations_register_once_and_changed_input_does_not_mutate(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let (a, b, c, d) = tokio::join!(
        f.reserve("concurrent-command-key", b"same"),
        f.reserve("concurrent-command-key", b"same"),
        f.reserve("concurrent-command-key", b"same"),
        f.reserve("concurrent-command-key", b"same")
    );
    let reservations = [a, b, c, d];
    assert_eq!(
        reservations
            .iter()
            .filter(|r| matches!(r, Reservation::Fresh(_)))
            .count(),
        1
    );
    let id = reservations
        .iter()
        .find_map(|r| match r {
            Reservation::Fresh(id) => Some(*id),
            _ => None,
        })
        .unwrap();
    for reservation in reservations {
        match reservation {
            Reservation::Fresh(own) => assert_eq!(own, id),
            Reservation::Existing(out) => assert_eq!(out.id, id),
            Reservation::Mismatch(_) => panic!("identical inputs must replay"),
        }
    }
    assert!(
        matches!(f.reserve("concurrent-command-key",b"changed").await,Reservation::Mismatch(own) if own==id)
    );
    let event = f.event(Some(id), "command.refused", "idempotency_key_reused", true);
    with_org_conn::<_, _, DbError>(&f.rt, f.org, move |tx| {
        Box::pin(async move { insert_audit_event(tx, &event).await })
    })
    .await
    .unwrap();
    assert_eq!(
        f.outcome(id).await.state,
        "PROCESSING",
        "mismatch must not settle the original request"
    );
    assert_eq!(f.domain_count().await, 0);
    assert_eq!(f.audit_count(id, "command.received").await, 1);
    assert_eq!(f.audit_count(id, "command.refused").await, 1);
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM command_outcomes WHERE org_id=$1")
        .bind(f.org.as_uuid())
        .fetch_one(&f.owner)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn runtime_rls_isolates_tenants_and_terminal_outcomes_are_immutable(pool: PgPool) {
    let a = Fixture::new(pool).await;
    let b = a.another().await;
    let id = a.fresh("shared-tenant-command-key").await;
    let other = b.fresh("shared-tenant-command-key").await;
    let unset: i64 = sqlx::query_scalar("SELECT count(*) FROM command_outcomes")
        .fetch_one(&a.rt)
        .await
        .unwrap();
    assert_eq!(unset, 0, "missing tenant context fails closed");
    assert!(
        command_outcomes::lookup(&a.rt, a.org, a.actor, other.to_string())
            .await
            .unwrap()
            .is_none()
    );
    let visible: i64 = with_org_conn::<_, _, DbError>(&a.rt, a.org, |tx| {
        Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT count(*) FROM command_outcomes")
                .fetch_one(tx.as_mut())
                .await?)
        })
    })
    .await
    .unwrap();
    assert_eq!(visible, 1);
    a.apply(id, "only-a").await.unwrap();
    let terminal = support::denied_statement(
        &a,
        "UPDATE command_outcomes SET state='PROCESSING',settled_at=NULL WHERE id=$1",
        id,
    )
    .await;
    assert!(
        terminal
            .to_string()
            .contains("settled command outcome is immutable")
    );
    let identity =
        sqlx::query("UPDATE command_outcomes SET inputs_masked='{\"secret\":true}' WHERE id=$1")
            .bind(id)
            .execute(&a.owner)
            .await
            .unwrap_err();
    assert!(identity.to_string().contains("identity is immutable"));
    assert!(
        support::denied_statement(&a, "DELETE FROM command_outcomes WHERE id=$1", id)
            .await
            .to_string()
            .contains("permission denied")
    );
    assert_eq!(a.outcome(id).await.state, "APPLIED");
    assert_eq!(b.outcome(other).await.state, "PROCESSING");
    assert_eq!(a.domain_count().await, 1);
    assert_eq!(b.domain_count().await, 0);
    assert_eq!(a.audit_count(id, "ledger.apply").await, 1);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn expiry_refusal_blocks_wrapper_and_rolls_back_late_raw_mutation_at_commit(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let id = f.fresh("expired-command-key").await;
    assert!(f.outcome(id).await.deadline.is_some());
    with_org_conn::<_, _, DbError>(&f.rt, f.org, move |tx| {
        Box::pin(async move {
            sqlx::query(
                "UPDATE command_outcomes SET deadline=now()-interval '1 second' WHERE id=$1",
            )
            .bind(id)
            .execute(tx.as_mut())
            .await?;
            Ok(())
        })
    })
    .await
    .unwrap();
    command_outcomes::expire_abandoned(&f.rt, f.org)
        .await
        .unwrap();
    let expired = f.outcome(id).await;
    assert_eq!(expired.state, "EXPIRED");
    assert_eq!(expired.refusal_code.as_deref(), Some("command_expired"));
    assert_eq!(f.audit_count(id, "command.expired").await, 1);
    assert!(
        f.apply(id, "too-late-wrapper")
            .await
            .unwrap_err()
            .to_string()
            .contains("already settled")
    );
    let org = f.org;
    let event = f.event(Some(id), "ledger.apply", "too-late-raw", false);
    let late = with_org_conn::<_, _, DbError>(&f.rt, org, move |tx| {
        Box::pin(async move {
            support::write(tx, org, "too-late-raw").await?;
            insert_audit_event(tx, &event).await?;
            Ok(())
        })
    })
    .await
    .unwrap_err();
    assert!(late.to_string().contains("already settled"), "{late}");
    assert_eq!(f.domain_count().await, 0);
    assert_eq!(f.audit_count(id, "ledger.apply").await, 0);
    command_outcomes::expire_abandoned(&f.rt, f.org)
        .await
        .unwrap();
    assert_eq!(f.audit_count(id, "command.expired").await, 1);
    assert_eq!(f.outcome(id).await.state, "EXPIRED");
    let result: Option<Value> =
        sqlx::query_scalar("SELECT result FROM command_outcomes WHERE id=$1")
            .bind(id)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(result, None);
}
