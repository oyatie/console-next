#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! decisions #15.2 as `console_rt`: the facts a scope grant's 업무위탁 basis is
//! checked against — the tenant setting (default on, a tenant may turn it
//! off) and whether the holder is employed by the target 법인.

mod common;

use common::*;
use console_entity_application::{BindAssignment, GrantBasisFacts, Target};
use console_entity_domain::cross_entity::{GrantBasisInput, check_grant_basis};
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E25);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_grant_on_another_entity_needs_its_basis_until_the_tenant_opts_out(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let mut entities = Vec::new();
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
        entities.push((entity, wp));
    }
    let [(a, a_wp), (b, b_wp)] = entities[..] else {
        unreachable!()
    };
    // The holder is the admin's own account, employed by 법인 A.
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, '주식회사 가나', '김인사', 'x', 'x', 1, 'k1') RETURNING id",
    )
    .bind(ORG)
    .fetch_one(&owner)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET employee_id = $2 WHERE id = $1")
        .bind(actor.user.as_uuid())
        .bind(employee)
        .execute(&owner)
        .await
        .unwrap();
    let bind = BindAssignment {
        employee_id: employee,
        legal_entity_id: Some(a),
        workplace_id: Some(a_wp),
        valid_from: Some("2026-01-02".into()),
    };
    store.bind_assignment(&cmd(&actor), bind).await.unwrap();

    let facts = |target| store.grant_basis_facts(&actor, actor.user, target);
    let own = GrantBasisFacts {
        required: true,
        holder_employed_by_target: true,
    };
    let other = GrantBasisFacts {
        required: true,
        holder_employed_by_target: false,
    };
    assert_eq!(facts(Target::Entity(a)).await.unwrap(), own);
    assert_eq!(facts(Target::Workplace(a_wp)).await.unwrap(), own);
    assert_eq!(facts(Target::Tenant).await.unwrap(), own);
    assert_eq!(facts(Target::Entity(b)).await.unwrap(), other);
    let on_b = facts(Target::Workplace(b_wp)).await.unwrap();
    assert_eq!(on_b, other);

    // So a grant on 법인 B needs the 업무위탁 basis by default.
    let today = time::macros::date!(2026 - 10 - 05);
    let none = GrantBasisInput::default();
    let refused = check_grant_basis(on_b.required, on_b.holder_employed_by_target, &none, today);
    assert!(refused.is_err());

    // Turning it off is a loosening: once people are on file it waits out
    // the 24 h delay (D0.3), and until then the basis stays required.
    sqlx::query(
        "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code, effective_from) \
         VALUES ($1, 'authz.cross_entity_grant.basis_required', 'false', $2, 'X', now() + interval '25 hours')",
    )
    .bind(ORG)
    .bind(actor.user.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    assert!(facts(Target::Entity(b)).await.unwrap().required);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_tenant_that_opts_out_tracks_no_basis(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let b = store
        .create_entity(&cmd(&actor), corporation("주식회사 다라", "000111-0000003"))
        .await
        .unwrap()
        .record
        .id;
    // Before anyone is on file the change applies at once (onboarding).
    sqlx::query(
        "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
         VALUES ($1, 'authz.cross_entity_grant.basis_required', 'false', $2, 'X')",
    )
    .bind(ORG)
    .bind(actor.user.as_uuid())
    .execute(&owner)
    .await
    .unwrap();
    let off = store
        .grant_basis_facts(&actor, actor.user, Target::Entity(b))
        .await
        .unwrap();
    assert_eq!(
        off,
        GrantBasisFacts {
            required: false,
            holder_employed_by_target: false
        }
    );
    let today = time::macros::date!(2026 - 10 - 05);
    let none = GrantBasisInput::default();
    assert_eq!(
        check_grant_basis(off.required, off.holder_employed_by_target, &none, today).unwrap(),
        None
    );
}
