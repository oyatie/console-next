#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! MR-14 as `console_rt`: a 사업장 폐업 (status CLOSED) sets its closed_on once
//! it is empty, refuses new placements (adapter and 0264) and reopens on a
//! later revision; the orgchange port closes one inside its own transaction.

mod close_support;
mod common;

use close_support::*;
use common::*;
use console_entity_adapter_postgres::close_workplace_in_tx;
use console_entity_application::{CreateWorkplace, RegistrationStatusInput, Revision};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_workplace_closes_once_empty_refuses_placements_and_reopens(owner: PgPool) {
    let w = world(&owner).await;
    let spare = CreateWorkplace {
        is_head_office: None,
        ..workplace_from(w.reg, "대전지점")
    };
    let spare = w
        .store
        .create_workplace(&cmd(&w.actor), w.entity, spare, port())
        .await
        .unwrap()
        .record
        .id;
    let kim = employee(&owner, "k1").await;
    w.store
        .bind_assignment(&cmd(&w.actor), bind(&w, kim, w.branch, "2025-01-01"))
        .await
        .unwrap();

    // Someone still works there: refused, nothing written.
    let (code_, _, remedy) = code(
        set_status(&w, w.branch, "부산지점", "CLOSED", Some("2026-01-31"))
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("record_in_use", Some("move_people_first"))
    );
    assert_eq!(closed_on(&owner, "workplaces", w.branch).await, None);

    // Moved on 2026-01-01 (before the 폐업일): the 사업장 closes and its SITE unit dissolves.
    w.store
        .bind_assignment(&cmd(&w.actor), bind(&w, kim, spare, "2026-01-01"))
        .await
        .unwrap();
    set_status(&w, w.branch, "부산지점", "CLOSED", Some("2026-01-31"))
        .await
        .unwrap();
    assert_eq!(
        closed_on(&owner, "workplaces", w.branch).await,
        Some(date("2026-01-31"))
    );
    assert_eq!(head(&owner, w.branch).await, ("CLOSED".into(), false));
    let closed = w.store.get_entity(&w.actor, w.entity, true).await.unwrap();
    assert!(
        closed
            .workplaces
            .iter()
            .find(|p| p.id == w.branch)
            .unwrap()
            .org_unit_id
            .is_none()
    );

    // No new placement there: the adapter refuses with its own code, and 0264 backs every writer.
    let lee = employee(&owner, "k2").await;
    let (_, fields, _) = code(
        w.store
            .bind_assignment(&cmd(&w.actor), bind(&w, lee, w.branch, "2026-02-01"))
            .await
            .unwrap_err(),
    );
    assert_eq!(
        fields,
        vec![("workplace_id".to_owned(), "workplace_closed")]
    );
    let raw = "INSERT INTO employment_assignments (org_id, employee_id, legal_entity_id, workplace_id, valid_from, valid_to, cause, actor_id, command_id) \
               VALUES ($1, $2, $3, $4, $5, $6, 'CORRECTION', $7, gen_random_uuid())";
    let err = sqlx::query(raw)
        .bind(ORG)
        .bind(lee)
        .bind(w.entity)
        .bind(w.branch)
        .bind(date("2026-01-15"))
        .bind(None::<time::Date>)
        .bind(*w.actor.user.as_uuid())
        .execute(&owner)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("workplace_closed"), "{err}");
    // History that ends by the 폐업일 is still recordable.
    sqlx::query(raw)
        .bind(ORG)
        .bind(lee)
        .bind(w.entity)
        .bind(w.branch)
        .bind(date("2025-06-01"))
        .bind(Some(date("2026-01-31")))
        .bind(*w.actor.user.as_uuid())
        .execute(&owner)
        .await
        .unwrap();

    // The 본사/대표 사업장 does not close alone while another 사업장 is open.
    let (code_, _, remedy) = code(
        set_status(&w, w.hq, "본사", "CLOSED", Some("2026-01-31"))
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        (
            "workplace_holds_entity_role",
            Some("change_entity_roles_first")
        )
    );

    // The registration does not close while open 사업장 file under it.
    let rev = Revision {
        expected_version: Some(1),
        effective_from: Some("2026-01-31".into()),
        reason_code: Some("STATUS".into()),
        input: certificate("000-81-00009"),
    };
    let (code_, _, remedy) = code(
        w.store
            .revise_registration(
                &cmd(&w.actor),
                w.reg,
                rev,
                RegistrationStatusInput {
                    status: Some("CLOSED".into()),
                    status_since: Some("2026-01-31".into()),
                    status_until: None,
                },
            )
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("record_in_use", Some("close_workplaces_first"))
    );

    // A later revision back to 계속 reopens it with a new SITE unit; placements work again.
    set_status(&w, w.branch, "부산지점", "CONTINUING", None)
        .await
        .unwrap();
    assert_eq!(closed_on(&owner, "workplaces", w.branch).await, None);
    assert_eq!(head(&owner, w.branch).await, ("CONTINUING".into(), true));
    let reopened = w.store.get_entity(&w.actor, w.entity, true).await.unwrap();
    let replacement = reopened
        .workplaces
        .iter()
        .find(|p| p.id == w.branch)
        .unwrap()
        .org_unit_id;
    assert!(replacement.is_some());
    let chart = w.store.org_structure(&w.actor).await.unwrap();
    assert_eq!(
        chart.entities[0]
            .children
            .iter()
            .find(|p| p.id == w.branch)
            .unwrap()
            .org_unit_id,
        replacement
    );
    w.store
        .bind_assignment(&cmd(&w.actor), bind(&w, lee, w.branch, "2026-02-01"))
        .await
        .unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_orgchange_port_closes_a_workplace_inside_its_transaction(owner: PgPool) {
    let w = world(&owner).await;
    let close = |command: Uuid| {
        let (store, user, branch) = (w.store.clone(), w.actor.user, w.branch);
        async move {
            let mut tx = store.pool().begin().await.unwrap();
            sqlx::query("SELECT set_config('app.current_org', $1, true)")
                .bind(ORG.to_string())
                .execute(&mut *tx)
                .await
                .unwrap();
            let out =
                close_workplace_in_tx(&mut tx, user, command, branch, date("2026-03-31")).await;
            tx.commit().await.unwrap();
            out
        }
    };
    close(Uuid::new_v4()).await.unwrap();
    assert_eq!(
        closed_on(&owner, "workplaces", w.branch).await,
        Some(date("2026-03-31"))
    );
    let (status, since): (String, Option<time::Date>) = sqlx::query_as(
        "SELECT status, status_since FROM workplace_revisions WHERE workplace_id = $1 ORDER BY version DESC LIMIT 1",
    )
    .bind(w.branch)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), since),
        ("CLOSED", Some(date("2026-03-31")))
    );
    assert_eq!(
        code(close(Uuid::new_v4()).await.unwrap_err()).0,
        "workplace_already_closed"
    );
}
