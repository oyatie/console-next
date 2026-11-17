// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/trail_queries.rs"]
mod trail_queries;

use console_ontology_canonical_adapter_postgres::person::{
    PersonCommand, PersonError, PersonQuery, create_many_in_tx, write_in_tx,
};
use sqlx::{PgPool, Postgres, Transaction};
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

async fn transaction(f: &fixture::Fixture) -> Transaction<'static, Postgres> {
    let mut tx = f.rt.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(f.principal.org_id.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx
}

fn command(f: &fixture::Fixture, id: Uuid) -> PersonCommand {
    PersonCommand::create_bound(f.principal.org_id, f.principal.user_id, id, "합성 직원")
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_person_creates_share_one_statement_and_replay_the_same_receipts(
    pool: PgPool,
) {
    let f = fixture::fixture(pool.clone()).await;
    let foreign = fixture::fixture(pool.clone()).await;
    let foreign_id = Uuid::new_v4();
    let mut foreign_command = command(&foreign, foreign_id);
    foreign_command.query = PersonQuery::Create {
        employee_id: None,
        attributes: serde_json::json!({"legal_name":"다른 직원"}),
    };
    let mut tx = transaction(&foreign).await;
    let foreign_receipt = write_in_tx(&mut tx, &foreign_command).await.unwrap();
    tx.commit().await.unwrap();

    let ids: Vec<_> = (0..2_000).map(|_| Uuid::new_v4()).collect();
    sqlx::query("INSERT INTO employees (org_id,id,company,name,source_filename,source_sheet,source_row,source_key) \
        SELECT $1,id,'Co','합성 직원','fixture','people',1,id::text FROM unnest($2::uuid[]) id")
        .bind(f.principal.org_id.as_uuid()).bind(&ids).execute(&pool).await.unwrap();
    let commands: Vec<_> = ids.iter().map(|id| command(&f, *id)).collect();
    let mut tx = transaction(&f).await;
    let queries = trail_queries::Queries::default();
    let receipts = create_many_in_tx(&mut tx, &commands)
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    assert_eq!(
        queries.statements().len(),
        1,
        "one round trip for the full chunk"
    );
    assert_eq!(receipts.len(), 2_000);
    for ((id, command), receipt) in ids.iter().zip(&commands).zip(&receipts) {
        assert_eq!(receipt.command_id(), command.command_id);
        assert_eq!(receipt.actor_id(), f.principal.user_id);
        assert_eq!(receipt.result()["person_id"], id.to_string());
        assert_eq!(receipt.result()["version"], 1);
    }
    let replay = create_many_in_tx(&mut tx, &commands).await.unwrap();
    for (first, repeated) in receipts.iter().zip(&replay) {
        assert_eq!(first.result(), repeated.result());
        assert_eq!(first.payload_digest(), repeated.payload_digest());
        assert_eq!(first.created_at(), repeated.created_at());
    }
    let repeated = create_many_in_tx(&mut tx, &[commands[0].clone(), commands[0].clone()])
        .await
        .unwrap();
    assert_eq!(repeated.len(), 2);
    assert_eq!(repeated[0].result(), repeated[1].result());
    assert!(create_many_in_tx(&mut tx, &[]).await.unwrap().is_empty());
    let counts: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT \
        (SELECT count(*) FROM persons WHERE id=ANY($1)), \
        (SELECT count(*) FROM person_revisions WHERE person_id=ANY($1)), \
        (SELECT count(*) FROM employee_person_bindings WHERE employee_id=ANY($1)), \
        (SELECT count(*) FROM ont_action_command_receipts WHERE receipt->>'person_id'=ANY($2))",
    )
    .bind(&ids)
    .bind(ids.iter().map(ToString::to_string).collect::<Vec<_>>())
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    assert_eq!(counts, (2_000, 2_000, 2_000, 2_000));
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM persons WHERE org_id=$1")
        .bind(foreign.principal.org_id.as_uuid())
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
    assert_eq!(visible, 0);
    tx.commit().await.unwrap();
    let mut tx = transaction(&foreign).await;
    assert_eq!(
        write_in_tx(&mut tx, &foreign_command)
            .await
            .unwrap()
            .result(),
        foreign_receipt.result()
    );
    tx.commit().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn batch_validation_rejects_bad_attributes_revisions_and_conflicting_duplicate_commands(
    pool: PgPool,
) {
    let f = fixture::fixture(pool).await;
    let good = command(&f, Uuid::new_v4());
    let mut invalid = good.clone();
    invalid.query = PersonQuery::Create {
        employee_id: None,
        attributes: serde_json::json!("invalid"),
    };
    let mut revision = good.clone();
    revision.query = PersonQuery::Revise {
        person_id: Uuid::new_v4(),
        employee_id: None,
        attributes: serde_json::json!({}),
    };
    let mut conflict = good.clone();
    conflict.query = PersonQuery::Create {
        employee_id: None,
        attributes: serde_json::json!({"legal_name":"다른 직원"}),
    };
    let mut tx = transaction(&f).await;
    for (bad, digest_conflict) in [(invalid, false), (revision, false), (conflict, true)] {
        let queries = trail_queries::Queries::default();
        let error = create_many_in_tx(&mut tx, &[good.clone(), bad])
            .with_subscriber(queries.clone())
            .await
            .unwrap_err();
        if digest_conflict {
            assert!(matches!(error, PersonError::DigestConflict(_)));
        } else {
            assert!(matches!(error, PersonError::Blocked(_)));
        }
        assert!(
            queries.statements().is_empty(),
            "validate the full batch before writing"
        );
    }
    tx.rollback().await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn batch_foreign_tenant_and_stored_digest_failures_roll_back_every_new_person(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let foreign = fixture::fixture(pool.clone()).await;
    let mut unbound = command(&f, Uuid::new_v4());
    unbound.query = PersonQuery::Create {
        employee_id: None,
        attributes: serde_json::json!({"legal_name":"합성 직원"}),
    };
    let mut tx = transaction(&f).await;
    write_in_tx(&mut tx, &unbound).await.unwrap();
    tx.commit().await.unwrap();
    let fresh = PersonCommand {
        command_id: console_ontology_canonical_domain::CommandId::from_uuid(Uuid::new_v4()),
        ..unbound.clone()
    };
    let mut conflict = unbound.clone();
    conflict.query = PersonQuery::Create {
        employee_id: None,
        attributes: serde_json::json!({}),
    };
    let mut tx = transaction(&f).await;
    assert!(matches!(
        create_many_in_tx(&mut tx, &[fresh.clone(), conflict]).await,
        Err(PersonError::DigestConflict(_))
    ));
    tx.rollback().await.unwrap();
    let foreign_command = PersonCommand {
        org_id: foreign.principal.org_id,
        actor_id: foreign.principal.user_id,
        ..unbound
    };
    let mut tx = transaction(&f).await;
    assert!(
        create_many_in_tx(&mut tx, &[fresh.clone(), foreign_command])
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    let stored: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ont_action_command_receipts WHERE command_id=$1)",
    )
    .bind(fresh.command_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!stored);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn duplicate_creates_keep_the_first_commands_receipt_metadata(pool: PgPool) {
    let f = fixture::fixture(pool).await;
    let mut first = command(&f, Uuid::new_v4());
    first.query = PersonQuery::Create {
        employee_id: None,
        attributes: serde_json::json!({"legal_name":"합성 직원"}),
    };
    let mut duplicate = first.clone();
    duplicate.action_key = "different_metadata".into();
    duplicate.object_type_id = Uuid::new_v4();
    let mut tx = transaction(&f).await;
    let receipts = create_many_in_tx(&mut tx, &[first.clone(), duplicate])
        .await
        .unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].result(), receipts[1].result());
    let stored: (String, Uuid) = sqlx::query_as(
        "SELECT action_key,object_type_id FROM ont_action_command_receipts WHERE org_id=$1 AND command_id=$2",
    ).bind(first.org_id.as_uuid()).bind(first.command_id.as_uuid())
        .fetch_one(tx.as_mut()).await.unwrap();
    assert_eq!(stored, (first.action_key, first.object_type_id));
    tx.commit().await.unwrap();
}
