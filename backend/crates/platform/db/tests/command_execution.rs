#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Committed steps belong only to the active admitted attempt; retries never inherit it.
#[path = "command_ledger_support/mod.rs"]
mod support;
use console_platform_db::{
    DbError, command_context,
    command_outcomes::{self, execution},
    with_audits,
};
use serde_json::json;
use sqlx::{PgPool, Row};
use support::Fixture;
use uuid::Uuid;
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
async fn step(f: &Fixture, id: Uuid, target: &str) -> Result<(), DbError> {
    let org = f.org;
    let target = target.to_owned();
    let event = f.event(Some(id), "ledger.apply", &target, false);
    with_audits(&f.rt, org, move |tx| {
        Box::pin(async move {
            support::write(tx, org, &target).await?;
            command_outcomes::set_result(tx, &json!({"id":target})).await?;
            Ok(((), vec![event]))
        })
    })
    .await
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn active_attempt_can_commit_steps_but_other_attempts_and_finished_tokens_cannot(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let id = f.fresh("multi-step-command").await;
    let other = f.another().await;
    assert!(
        execution::claim(&other.rt, other.org, id)
            .await
            .unwrap()
            .is_none()
    );
    let token = execution::claim(&f.rt, f.org, id).await.unwrap().unwrap();
    assert!(execution::claim(&f.rt, f.org, id).await.unwrap().is_none());
    command_context::scope_execution(f.context(Some(id)), Some(token), async {
        step(&f, id, "first").await.unwrap();
        assert_eq!(f.outcome(id).await.state, "APPLIED");
        assert_eq!(
            f.outcome(id).await.result,
            None,
            "incomplete result cannot replay"
        );
        let denied = f.apply(id, "foreign-attempt").await.unwrap_err();
        assert!(denied.to_string().contains("already settled"));
        step(&f, id, "second").await.unwrap();
        execution::finish(
            &f.rt,
            f.org,
            id,
            Some(json!({"id":"second","complete":true})),
            Some(202),
        )
        .await
        .unwrap();
        assert!(
            step(&f, id, "after-finish")
                .await
                .unwrap_err()
                .to_string()
                .contains("already settled")
        );
    })
    .await;
    let out = f.outcome(id).await;
    assert_eq!(out.touched.as_array().unwrap().len(), 2);
    assert_eq!(out.result, Some(json!({"id":"second","complete":true})));
    assert_eq!(out.response_status, Some(202));
    assert_eq!(f.domain_count().await, 2);
    assert_eq!(f.audit_count(id, "ledger.apply").await, 2);
    assert!(
        support::denied_statement(
            &f,
            "UPDATE command_outcomes SET result=\'{\"forged\":true}\' WHERE id=$1",
            id
        )
        .await
        .to_string()
        .contains("immutable")
    );
    assert!(execution::claim(&f.rt, f.org, id).await.unwrap().is_none());
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn definitively_rolled_back_attempt_releases_same_identity_without_reopening_applied(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let id = f.fresh("rollback-retry-command").await;
    let token = execution::claim(&f.rt, f.org, id).await.unwrap().unwrap();
    command_context::scope_execution(f.context(Some(id)), Some(token), async {
        let org = f.org;
        let result: Result<(), DbError> = with_audits(&f.rt, org, move |tx| {
            Box::pin(async move {
                support::write(tx, org, "rolled-back").await?;
                Err(DbError::Sqlx(sqlx::Error::Protocol(
                    "definite rollback".into(),
                )))
            })
        })
        .await;
        assert!(result.is_err());
        execution::finish(&f.rt, f.org, id, None, None)
            .await
            .unwrap();
        assert!(
            step(&f, id, "stale-rollback-token")
                .await
                .unwrap_err()
                .to_string()
                .contains("already settled")
        );
    })
    .await;
    assert_eq!(f.domain_count().await, 0);
    let resumed = execution::claim(&f.rt, f.org, id).await.unwrap().unwrap();
    assert_ne!(resumed, token);
    command_context::scope_execution(f.context(Some(id)), Some(resumed), async {
        step(&f, id, "once").await.unwrap();
        execution::finish(&f.rt, f.org, id, None, None)
            .await
            .unwrap();
    })
    .await;
    assert_eq!(f.domain_count().await, 1);
    assert_eq!(f.audit_count(id, "command.received").await, 1);
    assert!(execution::claim(&f.rt, f.org, id).await.unwrap().is_none());
}
#[sqlx::test(migrator = "MIGRATOR")]
async fn expired_active_capability_refuses_new_business_step_and_emits_no_audit(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let id = f.fresh("expired-active-command").await;
    let token = execution::claim(&f.rt, f.org, id).await.unwrap().unwrap();
    sqlx::query(
        "UPDATE command_outcomes SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
    )
    .bind(id)
    .execute(&f.owner)
    .await
    .unwrap();
    command_context::scope_execution(f.context(Some(id)), Some(token), async {
        assert!(
            step(&f, id, "late")
                .await
                .unwrap_err()
                .to_string()
                .contains("already settled")
        );
    })
    .await;
    assert_eq!(f.domain_count().await, 0);
    assert_eq!(f.audit_count(id, "ledger.apply").await, 0);
    f.deny(id, "command_expired").await;
    assert_eq!(f.masked_audit(id).await["outcome"], "DENIED");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn failed_second_step_keeps_committed_effects_but_never_replays_provisional_success(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let id = f.fresh("partial-error-command").await;
    let token = execution::claim(&f.rt, f.org, id).await.unwrap().unwrap();
    command_context::scope_execution(f.context(Some(id)), Some(token), async {
        step(&f, id, "committed").await.unwrap();
        let org = f.org;
        let failed: Result<(), DbError> = with_audits(&f.rt, org, move |tx| {
            Box::pin(async move {
                support::write(tx, org, "rolled-back-step").await?;
                Err(DbError::Sqlx(sqlx::Error::Protocol(
                    "validation_error".into(),
                )))
            })
        })
        .await;
        assert!(failed.is_err());
        command_outcomes::settle_refused(
            &f.rt,
            f.org,
            id,
            "REFUSED".into(),
            "validation_error".into(),
            f.event(Some(id), "command.refused", "validation_error", true),
        )
        .await
        .unwrap();
        execution::finish(&f.rt, f.org, id, None, None)
            .await
            .unwrap();
    })
    .await;
    let outcome = f.outcome(id).await;
    assert_eq!(outcome.state, "APPLIED");
    assert_eq!(outcome.result, None);
    assert_eq!(outcome.response_status, None);
    assert_eq!(f.domain_count().await, 1);
    assert_eq!(f.audit_count(id, "ledger.apply").await, 1);
    assert_eq!(f.audit_count(id, "command.refused").await, 1);
    assert!(execution::claim(&f.rt, f.org, id).await.unwrap().is_none());
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn raw_sql_command_audit_inherits_context_and_completion_invalidates_without_values(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let id = f.fresh("raw-context-command").await;
    let token = execution::claim(&f.rt, f.org, id).await.unwrap().unwrap();
    command_context::scope_execution(f.context(Some(id)),Some(token),async {
        let org=f.org;let actor=f.actor;
        console_platform_db::with_org_conn::<_,_,DbError>(&f.rt,org,move |tx|Box::pin(async move{
            support::write(tx,org,"raw-owned").await?;
            sqlx::query("INSERT INTO audit_events(actor,action,target_type,target_id,org_id,trace_id,span_id,occurred_at) VALUES($1,'ledger.raw','ledger_probe','raw-owned',$2,repeat('a',32),repeat('b',16),now())")
                .bind(actor.as_uuid()).bind(org.as_uuid()).execute(tx.as_mut()).await?;
            Ok(())
        })).await.unwrap();
        assert_eq!(f.outcome(id).await.state,"APPLIED");
        execution::finish(&f.rt,org,id,Some(json!({"id":"raw-owned"})),Some(200)).await.unwrap();
        let late=console_platform_db::with_org_conn::<_,_,DbError>(&f.rt,org,move |tx|Box::pin(async move{
            support::write(tx,org,"raw-late").await?;
            sqlx::query("INSERT INTO audit_events(actor,action,target_type,target_id,org_id,trace_id,span_id,occurred_at) VALUES($1,'ledger.raw','ledger_probe','raw-late',$2,repeat('a',32),repeat('b',16),now())")
                .bind(actor.as_uuid()).bind(org.as_uuid()).execute(tx.as_mut()).await?;
            Ok(())
        })).await.unwrap_err();
        assert!(late.to_string().contains("already settled"));
    }).await;
    let row=sqlx::query("SELECT command_id,source,actor_kind,change_mode,row_hash_version,decision_snapshot FROM audit_events WHERE org_id=$1 AND action='ledger.raw'")
        .bind(f.org.as_uuid()).fetch_one(&f.owner).await.unwrap();
    assert_eq!(row.get::<Uuid, _>("command_id"), id);
    assert_eq!(row.get::<String, _>("source"), "FORM");
    assert_eq!(row.get::<String, _>("actor_kind"), "OPS_ACCOUNT");
    assert_eq!(row.get::<String, _>("change_mode"), "GOVERNED");
    assert_eq!(row.get::<i16, _>("row_hash_version"), 2);
    assert!(
        row.get::<serde_json::Value, _>("decision_snapshot")
            .as_object()
            .unwrap()
            .len()
            > 20
    );
    let frames:Vec<Option<String>>=sqlx::query_scalar("SELECT resource_id FROM resource_changes WHERE org_id=$1 AND resource_type='command_outcome'")
        .bind(f.org.as_uuid()).fetch_all(&f.owner).await.unwrap();
    assert!(
        frames.len() >= 2,
        "first commit and finished result both invalidate"
    );
    assert!(frames.iter().all(Option::is_none));
    assert_eq!(f.domain_count().await, 1);
    assert_eq!(f.audit_count(id, "ledger.raw").await, 1);
}
