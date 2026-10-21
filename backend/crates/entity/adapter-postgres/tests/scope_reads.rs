#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! decisions #15, the SQL backstop of the Cedar scope rule
//! `scope_tenant || scope_entities.containsAny(resource)`, as `console_rt`:
//! a grant on 법인 B reaches B whoever employs the holder; a 사업장 grant
//! reaches that 사업장 (and shows its 법인); without a grant nothing crosses.

mod common;

use common::*;
use console_entity_application::{Actor, BindAssignment, EntityScope};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E15);

fn scoped(actor: &Actor, ids: &[Uuid]) -> Actor {
    Actor {
        scope: EntityScope::Only(ids.to_vec()),
        ..actor.clone()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn reads_stop_at_the_granted_entities_and_workplaces(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let mut ids = Vec::new();
    for (name, crn, brn) in [
        ("주식회사 가나", "000211-0006241", "000-81-00009"),
        ("주식회사 다라", "000111-0000005", "000-81-00071"),
    ] {
        let entity = store
            .create_entity(&cmd(&actor), corporation(name, crn))
            .await
            .unwrap()
            .record
            .id;
        let reg = store
            .create_registration(&cmd(&actor), entity, certificate(brn))
            .await
            .unwrap()
            .record
            .id;
        let wp = store
            .create_workplace(&cmd(&actor), entity, workplace_from(reg, "본사"), port())
            .await
            .unwrap()
            .record
            .id;
        ids.push((entity, reg, wp));
    }
    let [(a, a_reg, a_wp), (b, _, _)] = ids[..] else {
        unreachable!()
    };
    // A second 사업장 of A, outside a grant on A's first one.
    store
        .create_workplace(&cmd(&actor), a, workplace_from(a_reg, "부산지점"), port())
        .await
        .unwrap();
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, '주식회사 가나', '김직원', 'x', 'x', 1, 'k1') RETURNING id",
    )
    .bind(ORG)
    .fetch_one(&owner)
    .await
    .unwrap();
    let bind = BindAssignment {
        employee_id: employee,
        legal_entity_id: Some(a),
        workplace_id: Some(a_wp),
        valid_from: Some("2026-10-01".into()),
    };
    store.bind_assignment(&cmd(&actor), bind).await.unwrap();

    // The tenant scope sees both.
    assert_eq!(store.list_entities(&actor, false).await.unwrap().len(), 2);

    // A grant on 법인 B: B only, and nothing of A (#15.4).
    let on_b = scoped(&actor, &[b]);
    let seen: Vec<Uuid> = store
        .list_entities(&on_b, false)
        .await
        .unwrap()
        .iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(seen, vec![b]);
    let (code_, _, _) = code(store.get_entity(&on_b, a, false).await.unwrap_err());
    assert_eq!(code_, "legal_entity_not_found");
    assert!(
        store
            .list_assignments(&on_b, employee)
            .await
            .unwrap()
            .is_empty()
    );
    let tree = store.org_structure(&on_b).await.unwrap();
    assert_eq!(
        tree.entities.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![b]
    );

    // A grant on A's 사업장: A shows, with that 사업장, and its placements.
    let on_site = scoped(&actor, &[a_wp]);
    let seen = store.list_entities(&on_site, false).await.unwrap();
    assert_eq!(seen.iter().map(|e| e.id).collect::<Vec<_>>(), vec![a]);
    assert_eq!(
        seen[0].workplaces.iter().map(|w| w.id).collect::<Vec<_>>(),
        vec![a_wp]
    );
    assert_eq!(
        store
            .list_assignments(&on_site, employee)
            .await
            .unwrap()
            .len(),
        1
    );

    // No grant at all: nothing.
    assert!(
        store
            .list_entities(&scoped(&actor, &[]), false)
            .await
            .unwrap()
            .is_empty()
    );
}
