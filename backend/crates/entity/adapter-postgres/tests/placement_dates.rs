// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Placement dates respect the first workplace and employer records, including older data.

mod common;
#[path = "placement_dates/reads.rs"]
mod reads;

use common::{certificate, cmd, code, corporation, port, tenant, workplace_from};
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_adapter_postgres::employment_hire::{Placed, hire_in_tx};
use console_entity_adapter_postgres::employment_moves::{MoveTarget, MoveWrite, move_in_tx};
use console_entity_application::{Actor, BindAssignment, ReadOptions};
use console_kernel_core::{ErrorKind, KernelError};
use sqlx::PgPool;
use time::{Date, Month};
use uuid::Uuid;

struct World {
    store: PgEntityStore,
    actor: Actor,
    entity: Uuid,
    source: Uuid,
    target: Uuid,
}

async fn world(owner: &PgPool, entity_from: &str, workplace_from_date: &str) -> World {
    let (store, actor) = tenant(owner, Uuid::new_v4(), "placement-dates").await;
    let mut input = corporation("주식회사 기준일", "000211-0006241");
    input.incorporated_on = Some(entity_from.into());
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let mut places = Vec::new();
    for (name, date) in [("본사", entity_from), ("공장", workplace_from_date)] {
        let mut input = workplace_from(reg, name);
        input.input.opened_on = Some(date.into());
        places.push(
            store
                .create_workplace(&cmd(&actor), entity, input, port())
                .await
                .unwrap()
                .record
                .id,
        );
    }
    World {
        store,
        actor,
        entity,
        source: places[0],
        target: places[1],
    }
}

async fn employee(owner: &PgPool, actor: &Actor) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id,company,name,hire_date,source_filename,source_sheet, \
         source_row,source_key) VALUES ($1,'주식회사 기준일','김직원','2016-03-02', \
         'test','test',1,$2) RETURNING id",
    )
    .bind(*actor.org.as_uuid())
    .bind(Uuid::new_v4().to_string())
    .fetch_one(owner)
    .await
    .unwrap()
}

fn write(actor: &Actor, employee: Uuid) -> MoveWrite {
    MoveWrite {
        org_id: *actor.org.as_uuid(),
        employee_id: employee,
        actor_id: *actor.user.as_uuid(),
        command_id: Uuid::new_v4(),
    }
}

async fn hire(
    owner: &PgPool,
    actor: &Actor,
    employee: Uuid,
    workplace: Uuid,
    on: Date,
) -> Result<Placed, KernelError> {
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(actor.org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let result = hire_in_tx(tx.as_mut(), write(actor, employee), workplace, on).await;
    if result.is_ok() {
        tx.commit().await.unwrap();
    } else {
        tx.rollback().await.unwrap();
    }
    result
}

fn bind(employee: Uuid, w: &World, on: Date) -> BindAssignment {
    BindAssignment {
        employee_id: employee,
        legal_entity_id: Some(w.entity),
        workplace_id: Some(w.target),
        valid_from: Some(on.to_string()),
    }
}

async fn assert_hire_boundary(owner: &PgPool, entity_from: &str, workplace_from: &str, on: Date) {
    let w = world(owner, entity_from, workplace_from).await;
    let p = employee(owner, &w.actor).await;
    let error = hire(owner, &w.actor, p, w.target, on.previous_day().unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Validation);
    assert_eq!(error.code, Some("workplace_not_open_on_date"));
    assert_eq!(
        hire(owner, &w.actor, p, w.target, on)
            .await
            .unwrap()
            .legal_entity_id,
        w.entity
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hire_checks_the_workplace_first_effective_date(owner: PgPool) {
    assert_hire_boundary(
        &owner,
        "2020-03-02",
        "2020-05-01",
        Date::from_calendar_date(2020, Month::May, 1).unwrap(),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hire_checks_the_parent_entity_first_effective_date(owner: PgPool) {
    assert_hire_boundary(
        &owner,
        "2020-05-01",
        "2020-03-02",
        Date::from_calendar_date(2020, Month::May, 1).unwrap(),
    )
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn direct_binding_refuses_before_open_and_accepts_the_opening_date(owner: PgPool) {
    let w = world(&owner, "2020-03-02", "2020-05-01").await;
    let p = employee(&owner, &w.actor).await;
    let on = Date::from_calendar_date(2020, Month::May, 1).unwrap();
    let error = w
        .store
        .bind_assignment(&cmd(&w.actor), bind(p, &w, on.previous_day().unwrap()))
        .await
        .unwrap_err();
    assert_eq!(code(error).0, "workplace_not_open_on_date");
    let placed = w
        .store
        .bind_assignment(&cmd(&w.actor), bind(p, &w, on))
        .await
        .unwrap();
    assert_eq!(placed.valid_from, on);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_move_refuses_before_target_open_and_accepts_the_opening_date(owner: PgPool) {
    let w = world(&owner, "2020-03-02", "2020-05-01").await;
    let p = employee(&owner, &w.actor).await;
    hire(
        &owner,
        &w.actor,
        p,
        w.source,
        Date::from_calendar_date(2020, Month::March, 2).unwrap(),
    )
    .await
    .unwrap();
    let opening = Date::from_calendar_date(2020, Month::May, 1).unwrap();
    for on in [opening.previous_day().unwrap(), opening] {
        let mut tx = owner.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(w.actor.org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let result = move_in_tx(
            tx.as_mut(),
            write(&w.actor, p),
            MoveTarget {
                legal_entity_id: w.entity,
                workplace_id: w.target,
                group_transfer_id: None,
            },
            on,
        )
        .await;
        if on < opening {
            tx.rollback().await.unwrap();
            let error = result.unwrap_err();
            assert_eq!(error.kind, ErrorKind::Validation);
            assert_eq!(error.code, Some("workplace_not_open_on_date"));
        } else {
            result.unwrap();
            tx.commit().await.unwrap();
        }
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn legacy_objects_without_effective_records_keep_their_known_placement_date(owner: PgPool) {
    let (_, actor) = tenant(&owner, Uuid::new_v4(), "placement-legacy-dates").await;
    let (entity, workplace) = (Uuid::new_v4(), Uuid::new_v4());
    sqlx::query(
        "INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) \
         VALUES ($1,$2,true,'MIGRATION')",
    )
    .bind(*actor.org.as_uuid())
    .bind(entity)
    .execute(&owner)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workplaces (org_id,id,legal_entity_id,needs_confirmation,created_change_mode) \
         VALUES ($1,$2,$3,true,'MIGRATION')",
    )
    .bind(*actor.org.as_uuid())
    .bind(workplace)
    .bind(entity)
    .execute(&owner)
    .await
    .unwrap();
    let p = employee(&owner, &actor).await;
    assert_eq!(
        hire(
            &owner,
            &actor,
            p,
            workplace,
            Date::from_calendar_date(2016, Month::March, 2).unwrap(),
        )
        .await
        .unwrap()
        .workplace_id,
        workplace
    );
}
