#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Shared by the MR-14 / MR-15 close tests: a 법인 with a registration, its
//! 본사 and a 지점, people, and the stored state of a close.

use crate::common::*;
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::{Actor, BindAssignment, CreateWorkplace, Revision};
use console_entity_domain::workplace::WorkplaceInput;
use sqlx::PgPool;
use uuid::Uuid;

pub const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0C10_5E14);

pub struct World {
    pub owner: PgPool,
    pub store: PgEntityStore,
    pub actor: Actor,
    pub entity: Uuid,
    pub reg: Uuid,
    pub hq: Uuid,
    pub branch: Uuid,
}

pub async fn world(owner: &PgPool) -> World {
    let (store, actor) = tenant(owner, ORG, "C").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
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
    let hq = store
        .create_workplace(&cmd(&actor), entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap()
        .record
        .id;
    let branch = CreateWorkplace {
        is_head_office: None,
        ..workplace_from(reg, "부산지점")
    };
    let branch = store
        .create_workplace(&cmd(&actor), entity, branch, port())
        .await
        .unwrap()
        .record
        .id;
    World {
        owner: owner.clone(),
        store,
        actor,
        entity,
        reg,
        hq,
        branch,
    }
}

pub async fn employee(owner: &PgPool, key: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, '주식회사 가나', '김직원', 'x', 'x', 1, $2) RETURNING id",
    )
    .bind(ORG)
    .bind(key)
    .fetch_one(owner)
    .await
    .unwrap()
}

pub fn bind(w: &World, employee: Uuid, workplace: Uuid, from: &str) -> BindAssignment {
    BindAssignment {
        employee_id: employee,
        legal_entity_id: Some(w.entity),
        workplace_id: Some(workplace),
        valid_from: Some(from.into()),
    }
}

/// A full-state 사업장 revision carrying `status` since `since`.
pub async fn set_status(
    w: &World,
    workplace: Uuid,
    name: &str,
    status: &str,
    since: Option<&str>,
) -> Result<(), console_entity_adapter_postgres::PgEntityError> {
    let version: i32 =
        sqlx::query_scalar("SELECT max(version) FROM workplace_revisions WHERE workplace_id = $1")
            .bind(workplace)
            .fetch_one(&w.owner)
            .await
            .unwrap();
    let rev = Revision {
        expected_version: Some(version),
        effective_from: Some("2026-01-31".into()),
        reason_code: Some("STATUS".into()),
        input: WorkplaceInput {
            registration_id: None,
            status: Some(status.into()),
            status_since: since.map(Into::into),
            ..workplace_from(w.reg, name).input
        },
    };
    w.store
        .revise_workplace(&cmd(&w.actor), workplace, rev, port())
        .await
        .map(|_| ())
}

pub async fn closed_on(owner: &PgPool, table: &str, id: Uuid) -> Option<time::Date> {
    let sql = match table {
        "workplaces" => "SELECT closed_on FROM workplaces WHERE id = $1",
        "business_registrations" => "SELECT closed_on FROM business_registrations WHERE id = $1",
        _ => "SELECT closed_on FROM legal_entities WHERE id = $1",
    };
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(owner)
        .await
        .unwrap()
}

/// Status of the newest revision and whether its SITE unit is still placed.
pub async fn head(owner: &PgPool, workplace: Uuid) -> (String, bool) {
    sqlx::query_as(
        "SELECT (SELECT status FROM workplace_revisions WHERE workplace_id = $1 ORDER BY effective_from DESC, version DESC LIMIT 1), \
                EXISTS (SELECT 1 FROM org_unit_placements WHERE workplace_id = $1 AND represents_workplace AND valid_to IS NULL)",
    )
    .bind(workplace)
    .fetch_one(owner)
    .await
    .unwrap()
}

pub fn date(s: &str) -> time::Date {
    time::Date::parse(s, time::macros::format_description!("[year]-[month]-[day]")).unwrap()
}
