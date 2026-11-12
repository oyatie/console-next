// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_kernel_core::{ErrorKind, OrgId};
use console_platform_authz::access::{AccessSnapshot, load_access_subject};
use console_platform_authz::cedar_pbac::visible::load_facts_with_access;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn read_snapshot_cannot_substitute_another_account_or_tenant(pool: PgPool) {
    let org = OrgId::new();
    let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "read-snapshot").await;
    let runtime = runtime_role_pool(&pool).await;
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let subject = load_access_subject(
        &mut tx,
        org,
        *actor.as_uuid(),
        time::OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    let access = Arc::new(AccessSnapshot::new(subject.clone()));
    let facts = load_facts_with_access(&mut tx, org, *actor.as_uuid(), Some(access.clone()))
        .await
        .unwrap();
    assert!(std::ptr::eq(
        facts.access_permissions(org, *actor.as_uuid()).unwrap().1,
        access.slice().unwrap()
    ));
    assert!(
        facts
            .access_permissions(OrgId::new(), *actor.as_uuid())
            .is_err()
    );
    assert!(facts.access_permissions(org, Uuid::new_v4()).is_err());
    for (wrong_org, wrong_actor) in [(OrgId::new(), *actor.as_uuid()), (org, Uuid::new_v4())] {
        let mut wrong = subject.clone();
        wrong.org = wrong_org;
        wrong.account = wrong_actor;
        let error = load_facts_with_access(
            &mut tx,
            org,
            *actor.as_uuid(),
            Some(Arc::new(AccessSnapshot::new(wrong))),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Forbidden);
    }
}
