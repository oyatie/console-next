#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! A pre-ledger entity command replay must settle its newly reserved request,
//! while preserving the original domain outcome and audit exactly once.
mod common;

use common::{cmd, corporation, tenant};
use console_entity_application::Actor;
use console_entity_domain::legal_entity::LegalEntityInput;
use console_kernel_core::{AuditCommandContext, ErrorKind};
use console_platform_db::{command_context, command_outcomes};
use console_platform_test_support::runtime_role_pool;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

async fn reserve(
    owner: &PgPool,
    actor: &Actor,
    input: &LegalEntityInput,
) -> (PgPool, Uuid, AuditCommandContext) {
    let rt = runtime_role_pool(owner).await;
    let reservation = command_outcomes::reserve(
        &rt,
        actor.org,
        actor.user,
        actor.command_id.unwrap().to_string(),
        "POST /api/v1/legal-entities".into(),
        serde_json::to_vec(input).unwrap(),
        json!({"input":"masked"}),
    )
    .await
    .unwrap();
    let command_outcomes::Reservation::Fresh(id) = reservation else {
        panic!("the legacy command must not already have a current ledger entry");
    };
    let mut context = AuditCommandContext::for_actor(Some(actor.user));
    context.command_id = Some(id);
    (rt, id, context)
}
async fn audit_count(owner: &PgPool, actor: &Actor, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action=$2")
        .bind(actor.org.as_uuid())
        .bind(action)
        .fetch_one(owner)
        .await
        .unwrap()
}
async fn domain_outcome(owner: &PgPool, actor: &Actor) -> Value {
    sqlx::query_scalar("SELECT outcome FROM entity_commands WHERE org_id=$1 AND command_id=$2")
        .bind(actor.org.as_uuid())
        .bind(actor.command_id)
        .fetch_one(owner)
        .await
        .unwrap()
}
async fn domain_counts(owner: &PgPool, actor: &Actor) -> (i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM legal_entities WHERE org_id=$1),
        (SELECT count(*) FROM legal_entity_revisions WHERE org_id=$1)",
    )
    .bind(actor.org.as_uuid())
    .fetch_one(owner)
    .await
    .unwrap()
}
async fn outcome(rt: &PgPool, actor: &Actor) -> command_outcomes::CommandOutcome {
    command_outcomes::lookup(
        rt,
        actor.org,
        actor.user,
        actor.command_id.unwrap().to_string(),
    )
    .await
    .unwrap()
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_entity_replay_settles_current_ledger_without_typed_result(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "legacy-replay").await;
    let once = cmd(&actor);
    let input = corporation("Original entity", "000211-0006241");
    let first = store.create_entity(&once, input.clone()).await.unwrap();
    let original = domain_outcome(&owner, &once).await;
    assert_eq!(domain_counts(&owner, &once).await, (1, 1));
    assert_eq!(audit_count(&owner, &once, "legal_entity.create").await, 1);
    let (rt, id, context) = reserve(&owner, &once, &input).await;
    assert_eq!(outcome(&rt, &once).await.state, "PROCESSING");

    let again = command_context::scope(context, store.create_entity(&once, input))
        .await
        .unwrap();
    assert_eq!(again.record.id, first.record.id);
    assert_eq!(again.change_mode, first.change_mode);
    let recorded = outcome(&rt, &once).await;
    assert_eq!(recorded.id, id);
    assert_eq!(
        recorded.state, "APPLIED",
        "an existing domain outcome is a completed command"
    );
    assert!(recorded.settled_at.is_some());
    assert!(
        recorded.result.is_none(),
        "the old ledger cannot supply a typed response snapshot"
    );
    assert_eq!(domain_outcome(&owner, &once).await, original);
    assert_eq!(domain_counts(&owner, &once).await, (1, 1));
    assert_eq!(audit_count(&owner, &once, "legal_entity.create").await, 1);
    assert_eq!(audit_count(&owner, &once, "command.replayed").await, 1);
    let replay: Option<Uuid> = sqlx::query_scalar(
        "SELECT command_id FROM audit_events WHERE org_id=$1 AND action='command.replayed'",
    )
    .bind(once.org.as_uuid())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(replay, Some(id));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn mismatched_legacy_entity_replay_preserves_both_outcomes(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "legacy-mismatch").await;
    let once = cmd(&actor);
    let input = corporation("Original entity", "000211-0006241");
    store.create_entity(&once, input.clone()).await.unwrap();
    let original = domain_outcome(&owner, &once).await;
    let (rt, _, context) = reserve(&owner, &once, &input).await;
    let ledger_before = serde_json::to_value(outcome(&rt, &once).await).unwrap();
    let refusal = command_context::scope(
        context,
        store.create_entity(&once, corporation("Changed entity", "000211-0006241")),
    )
    .await
    .unwrap_err();
    let console_entity_adapter_postgres::PgEntityError::Refused(refusal) = refusal else {
        panic!("mismatched replay must return a domain refusal");
    };
    assert_eq!(refusal.kind, ErrorKind::Conflict);
    assert_eq!(refusal.code, "idempotency_key_reused");
    assert_eq!(refusal.remedy, Some("retry_with_new_key"));
    assert_eq!(domain_outcome(&owner, &once).await, original);
    assert_eq!(
        serde_json::to_value(outcome(&rt, &once).await).unwrap(),
        ledger_before
    );
    assert_eq!(domain_counts(&owner, &once).await, (1, 1));
    assert_eq!(audit_count(&owner, &once, "legal_entity.create").await, 1);
    assert_eq!(audit_count(&owner, &once, "command.replayed").await, 0);
}
