#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The MR-29 sheet fixture: 법인 A with its certificate, 본사 and a second
//! 사업장, and the batch a sheet import would send.

use crate::common::*;
use console_entity_application::{EntitySetupBatch, EntitySetupOp, EntitySetupResult};
use console_entity_domain::insurance::InsuranceSetupInput;
use console_entity_domain::workplace::WorkplaceInput;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

pub const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E29);

pub fn site(name: &str) -> WorkplaceInput {
    WorkplaceInput {
        name: Some(name.into()),
        address: Some(address("경기도 화성시 동탄대로 1")),
        opened_on: Some("2021-04-01".into()),
        insurance: Some(InsuranceSetupInput {
            shortcut: Some("ALL_ESTABLISHED_NUMBERS_LATER".into()),
            insurers: vec![],
        }),
        ..WorkplaceInput::default()
    }
}

pub fn op(kind: &str) -> EntitySetupOp {
    EntitySetupOp {
        op: Some(kind.into()),
        ..EntitySetupOp::default()
    }
}

/// A view as JSON minus revision bookkeeping (version, effective date,
/// derived counts), to compare records before and after an undo.
pub fn plain(v: &impl serde::Serialize) -> Value {
    fn strip(v: &mut Value) {
        match v {
            Value::Object(m) => {
                for k in ["version", "effective_from", "before_first_record"] {
                    m.remove(k);
                }
                m.values_mut().for_each(strip);
            }
            Value::Array(a) => a.iter_mut().for_each(strip),
            _ => {}
        }
    }
    let mut v = serde_json::to_value(v).unwrap();
    strip(&mut v);
    v
}

pub struct Fixture {
    pub store: console_entity_adapter_postgres::PgEntityStore,
    pub actor: console_entity_application::Actor,
    pub entity: Uuid,
    pub head: Uuid,
    pub branch: Uuid,
}

/// 법인 A with its certificate, 본사 (head office) and one more 사업장.
pub async fn fixture(owner: &PgPool) -> Fixture {
    let (store, actor) = tenant(owner, ORG, "S").await;
    let e = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), e, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    let head = store
        .create_workplace(&cmd(&actor), e, workplace_from(reg, "본사"), port())
        .await
        .unwrap()
        .record
        .id;
    let mut second = workplace_from(reg, "평택공장");
    second.is_head_office = None;
    second.input.registration_id = None;
    second.input.same_address_as_registration = false;
    second.input.address = Some(address("경기도 평택시 평택로 1"));
    let branch = store
        .create_workplace(&cmd(&actor), e, second, port())
        .await
        .unwrap()
        .record
        .id;
    Fixture {
        store,
        actor,
        entity: e,
        head,
        branch,
    }
}

/// The sheet: a new 법인 with a new 사업장, a capital change of A, its 평택공장
/// renamed and made 본사.
pub async fn sheet(f: &Fixture) -> EntitySetupBatch {
    let a = f.store.get_entity(&f.actor, f.entity, true).await.unwrap();
    let mut capital = corporation("주식회사 가나", "000211-0006241");
    capital.capital_won = Some(500_000_000);
    let wp = a.workplaces.iter().find(|w| w.id == f.branch).unwrap();
    let mut renamed = site("평택 제1공장");
    renamed.address = Some(address("경기도 평택시 평택로 1"));
    renamed.opened_on = Some("2020-03-02".into());
    renamed.insurance = None;
    renamed.status = Some("CONTINUING".into());
    let mut new_entity = corporation("주식회사 다라", "000111-1234560");
    new_entity.head_office_address = Some(address("부산광역시 해운대구 센텀로 1"));
    let today: time::Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(f.store.pool())
        .await
        .unwrap();
    EntitySetupBatch {
        effective_from: Some(today.to_string()),
        reason_code: Some("SHEET_IMPORT".into()),
        ops: vec![
            EntitySetupOp {
                reference: Some("e1".into()),
                entity: Some(new_entity),
                ..op("CREATE_ENTITY")
            },
            EntitySetupOp {
                entity_ref: Some("e1".into()),
                workplace: Some(site("동탄공장")),
                is_head_office: Some(true),
                ..op("CREATE_WORKPLACE")
            },
            EntitySetupOp {
                id: Some(f.entity),
                expected_version: a.current.as_ref().map(|c| c.version),
                entity: Some(capital),
                ..op("REVISE_ENTITY")
            },
            EntitySetupOp {
                id: Some(f.branch),
                expected_version: wp.current.as_ref().map(|c| c.version),
                workplace: Some(renamed),
                is_head_office: Some(true),
                ..op("REVISE_WORKPLACE")
            },
        ],
        ..EntitySetupBatch::default()
    }
}

pub async fn run(f: &Fixture, b: EntitySetupBatch) -> EntitySetupResult {
    f.store
        .entity_setup_batch(&cmd(&f.actor), b, port())
        .await
        .unwrap()
}
